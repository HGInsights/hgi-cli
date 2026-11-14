import type { RequestInit as UndiciInit } from 'undici';
import type { AuthedFetch } from '../authed-fetch.js';
import { debug } from '../debug.js';
import { HgiError, networkErrorCode } from '../errors.js';
import { parseRetryAfter, sleep, type HttpResponse } from '../http.js';

export const RETRY_BUDGET_MS = 60_000;
/** The per-request budget when `--retries` is set and `--retry-budget` is not. */
const RETRIES_BUDGET_MS = 600_000;
const MAX_RATE_RETRIES = 3;
const MAX_TRANSIENT_RETRIES = 2;
const PRE_DISPATCH_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

export interface TransportState {
  mcpVersion: string | null;
  toolsCallWritten: boolean;
  /** How many times a `tools/call` was handed to the network (retries included; the 401 refresh resend is not counted). */
  toolsCallSends: number;
}

type TransportRetryCode = 'rate_limited' | 'load_shed' | 'not_established';

export interface TransportRetryEvent {
  attempt: number;
  max: number;
  code: TransportRetryCode;
  wait_seconds: number;
}

export interface TransportRetryOptions {
  /** `--retries`: every retry class allows up to this many retries, each on its own counter. Undefined: built-in limits. */
  retries?: number;
  /** `--retry-budget` in ms. Undefined: 600 s when `retries` is set, else 60 s. */
  retryBudgetMs?: number;
  /** Called before every wait, with the wait that follows. */
  onRetry?: (e: TransportRetryEvent) => void;
}

export interface TransportFetchOptions extends TransportRetryOptions {
  timeoutMs: number;
  sleepFn?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export interface RetryLimits {
  rate: number;
  shed: number;
  transient: number;
  /** Without `--retries`, 429 and load-shed share one counter (`rate`), as before the option existed. */
  shared: boolean;
  budgetMs: number;
  /** Either option was given: not-established waits are then checked against the budget too. */
  configured: boolean;
}

export function retryLimits(opts: TransportRetryOptions): RetryLimits {
  const configured = opts.retries !== undefined || opts.retryBudgetMs !== undefined;
  const budgetMs = opts.retryBudgetMs ?? (opts.retries !== undefined ? RETRIES_BUDGET_MS : RETRY_BUDGET_MS);
  if (opts.retries !== undefined) {
    return { rate: opts.retries, shed: opts.retries, transient: opts.retries, shared: false, budgetMs, configured };
  }
  return { rate: MAX_RATE_RETRIES, shed: MAX_RATE_RETRIES, transient: MAX_TRANSIENT_RETRIES, shared: true, budgetMs, configured };
}

/** The most HTTP sends one request can make: the first, every retry, and a 401 refresh resend for each. */
export function maxHttpSends(limits: RetryLimits): number {
  const retries = (limits.shared ? limits.rate : limits.rate + limits.shed) + limits.transient;
  return 2 * (1 + retries);
}

function rpcMethod(init: UndiciInit | undefined): string | undefined {
  const body = init?.body;
  if (typeof body !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    const method = (parsed as { method?: unknown }).method;
    return typeof method === 'string' ? method : undefined;
  } catch {
    return undefined;
  }
}

async function isShed(res: HttpResponse): Promise<boolean> {
  const text = await res.text();
  if (res.status !== 503 || !res.headers.get('retry-after')) return false;
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown } };
    return parsed.error?.code === -32000;
  } catch {
    return false;
  }
}

export function createTransportFetch(
  authed: AuthedFetch,
  state: TransportState,
  opts: TransportFetchOptions,
): (url: string | URL, init?: RequestInit) => Promise<Response> {
  const wait = opts.sleepFn ?? sleep;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const limits = retryLimits(opts);

  return async (url, rawInit) => {
    const init = (rawInit ?? {}) as UndiciInit;
    const method = (init.method ?? 'GET').toUpperCase();
    const isPost = method === 'POST';
    const isToolsCall = isPost && rpcMethod(init) === 'tools/call';
    const signal = init.signal as AbortSignal | null | undefined;
    const started = now();
    let rateAttempts = 0;
    let shedAttempts = 0;
    let transientAttempts = 0;
    let sends = 0;
    const remaining = () => limits.budgetMs - (now() - started);
    /** Checked only when an option was given, so the defaults behave exactly as before the options existed. */
    const transientFits = () => !limits.configured || 500 * (transientAttempts + 1) <= remaining();
    const retryWait = async (code: TransportRetryCode, attempt: number, max: number, ms: number) => {
      opts.onRetry?.({ attempt, max, code, wait_seconds: Math.round(ms / 100) / 10 });
      await wait(ms, signal);
    };

    for (;;) {
      if (signal?.aborted) throw signal.reason;
      let res: HttpResponse;
      try {
        if (isToolsCall) {
          state.toolsCallWritten = true;
          state.toolsCallSends += 1;
        }
        sends += 1;
        res = await authed(String(url), init, { redirectKind: 'mcp', context: 'the MCP server', timeoutMs: opts.timeoutMs });
      } catch (err) {
        if (!(err instanceof HgiError) || err.code !== 'server_unreachable') throw err;
        const cause = networkErrorCode(err.cause) ?? (err.details?.cause as string | undefined);
        const preDispatch = Boolean(cause && PRE_DISPATCH_CODES.has(cause));
        if ((!isToolsCall || preDispatch) && transientAttempts < limits.transient && transientFits()) {
          transientAttempts += 1;
          await retryWait('not_established', transientAttempts, limits.transient, 500 * transientAttempts);
          continue;
        }
        const attempts = preDispatch || transientAttempts > 0 ? { attempts: sends } : {};
        if (isToolsCall) {
          throw new HgiError('server_unreachable', err.message, {
            hint: 'The call may or may not have run. Check state before re-running.',
            details: { ...err.details, outcome_unknown: true, ...attempts },
            cause: err.cause,
          });
        }
        // Every network failure of a non-call request is a not_established retry class: its retries ran out.
        throw new HgiError(err.code, err.message, { hint: err.hint, details: { ...err.details, attempts: sends }, cause: err.cause });
      }

      const headerVersion = res.headers.get('x-mcp-version');
      if (headerVersion) state.mcpVersion = headerVersion;
      if (!isPost) return res as unknown as Response;

      if (res.status === 429) {
        const header = parseRetryAfter(res.headers.get('retry-after'));
        await res.body?.cancel().catch(() => undefined);
        // Without --retries the backoff steps on the shared counter, so a load-shed retry moves it too (as before).
        const used = limits.shared ? rateAttempts + shedAttempts : rateAttempts;
        const delaySec = header ?? Math.min(2 ** (used + 1), 30) + random();
        if (used >= limits.rate || delaySec * 1000 > remaining()) {
          throw new HgiError('rate_limited', 'The organization is being rate limited by the server.', {
            hint: 'Wait and retry; the limit is shared by every hgi process in your organization.',
            details: { retry_after_seconds: header ?? Math.ceil(delaySec), attempts: sends },
          });
        }
        rateAttempts += 1;
        debug('429, waiting', delaySec);
        await retryWait('rate_limited', used + 1, limits.rate, delaySec * 1000 + random() * 250);
        continue;
      }

      if (res.status === 403) {
        await res.body?.cancel().catch(() => undefined);
        throw new HgiError('forbidden', 'The server refused this request (HTTP 403).', {
          hint: 'Your account or organization may not have access to this tool or endpoint.',
          details: { status: 403 },
        });
      }

      if (res.status >= 500) {
        const shed = await isShed(res);
        if (shed) {
          const header = parseRetryAfter(res.headers.get('retry-after')) ?? 1;
          const used = limits.shared ? rateAttempts + shedAttempts : shedAttempts;
          if (used >= limits.shed || header * 1000 > remaining()) {
            throw new HgiError('server_unreachable', 'The server is shedding load (503).', {
              hint: 'Nothing was run; retrying is safe.',
              details: { status: 503, outcome_unknown: false, retry_after_seconds: header, attempts: sends },
            });
          }
          shedAttempts += 1;
          await retryWait('load_shed', used + 1, limits.shed, header * 1000 + random() * 250);
          continue;
        }
        if (isToolsCall) {
          throw new HgiError('server_unreachable', `The server failed while running the tool (HTTP ${res.status}).`, {
            hint: 'The call may or may not have run. Check state before re-running.',
            details: { status: res.status, outcome_unknown: true },
          });
        }
        if ([502, 503, 504].includes(res.status) && transientAttempts < limits.transient && transientFits()) {
          transientAttempts += 1;
          await retryWait('not_established', transientAttempts, limits.transient, 500 * transientAttempts);
          continue;
        }
        throw new HgiError('server_unreachable', `The server returned HTTP ${res.status}.`, {
          hint: 'Retry in a moment.',
          details: { status: res.status, ...([502, 503, 504].includes(res.status) ? { attempts: sends } : {}) },
        });
      }

      return res as unknown as Response;
    }
  };
}

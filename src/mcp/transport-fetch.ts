import type { RequestInit as UndiciInit } from 'undici';
import type { AuthedFetch } from '../authed-fetch.js';
import { debug } from '../debug.js';
import { HgiError, networkErrorCode } from '../errors.js';
import { parseRetryAfter, sleep, type HttpResponse } from '../http.js';

export const RETRY_BUDGET_MS = 60_000;
const MAX_RATE_RETRIES = 3;
const MAX_TRANSIENT_RETRIES = 2;
const PRE_DISPATCH_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

export interface TransportState {
  mcpVersion: string | null;
  toolsCallWritten: boolean;
}

export interface TransportFetchOptions {
  timeoutMs: number;
  sleepFn?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  now?: () => number;
  random?: () => number;
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

  return async (url, rawInit) => {
    const init = (rawInit ?? {}) as UndiciInit;
    const method = (init.method ?? 'GET').toUpperCase();
    const isPost = method === 'POST';
    const isToolsCall = isPost && rpcMethod(init) === 'tools/call';
    const signal = init.signal as AbortSignal | null | undefined;
    const started = now();
    let rateAttempts = 0;
    let transientAttempts = 0;

    for (;;) {
      if (signal?.aborted) throw signal.reason;
      let res: HttpResponse;
      try {
        if (isToolsCall) state.toolsCallWritten = true;
        res = await authed(String(url), init, { redirectKind: 'mcp', context: 'the MCP server', timeoutMs: opts.timeoutMs });
      } catch (err) {
        if (!(err instanceof HgiError) || err.code !== 'server_unreachable') throw err;
        const cause = networkErrorCode(err.cause) ?? (err.details?.cause as string | undefined);
        if (isToolsCall) {
          if (cause && PRE_DISPATCH_CODES.has(cause) && transientAttempts < MAX_TRANSIENT_RETRIES) {
            transientAttempts += 1;
            await wait(500 * transientAttempts, signal);
            continue;
          }
          throw new HgiError('server_unreachable', err.message, {
            hint: 'The call may or may not have run. Check state before re-running.',
            details: { ...err.details, outcome_unknown: true },
            cause: err.cause,
          });
        }
        if (transientAttempts < MAX_TRANSIENT_RETRIES) {
          transientAttempts += 1;
          await wait(500 * transientAttempts, signal);
          continue;
        }
        throw err;
      }

      const headerVersion = res.headers.get('x-mcp-version');
      if (headerVersion) state.mcpVersion = headerVersion;
      if (!isPost) return res as unknown as Response;

      if (res.status === 429) {
        const header = parseRetryAfter(res.headers.get('retry-after'));
        await res.body?.cancel().catch(() => undefined);
        const delaySec = header ?? Math.min(2 ** (rateAttempts + 1), 30) + random();
        const remaining = RETRY_BUDGET_MS - (now() - started);
        if (rateAttempts >= MAX_RATE_RETRIES || delaySec * 1000 > remaining) {
          throw new HgiError('rate_limited', 'The organization is being rate limited by the server.', {
            hint: 'Wait and retry; the limit is shared by every hgi process in your organization.',
            details: { retry_after_seconds: header ?? Math.ceil(delaySec) },
          });
        }
        rateAttempts += 1;
        debug('429, waiting', delaySec);
        await wait(delaySec * 1000 + random() * 250, signal);
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
          const remaining = RETRY_BUDGET_MS - (now() - started);
          if (rateAttempts >= MAX_RATE_RETRIES || header * 1000 > remaining) {
            throw new HgiError('server_unreachable', 'The server is shedding load (503).', {
              hint: 'Nothing was run; retrying is safe.',
              details: { status: 503, outcome_unknown: false, retry_after_seconds: header },
            });
          }
          rateAttempts += 1;
          await wait(header * 1000 + random() * 250, signal);
          continue;
        }
        if (isToolsCall) {
          throw new HgiError('server_unreachable', `The server failed while running the tool (HTTP ${res.status}).`, {
            hint: 'The call may or may not have run. Check state before re-running.',
            details: { status: res.status, outcome_unknown: true },
          });
        }
        if ([502, 503, 504].includes(res.status) && transientAttempts < MAX_TRANSIENT_RETRIES) {
          transientAttempts += 1;
          await wait(500 * transientAttempts, signal);
          continue;
        }
        throw new HgiError('server_unreachable', `The server returned HTTP ${res.status}.`, {
          hint: 'Retry in a moment.',
          details: { status: res.status },
        });
      }

      return res as unknown as Response;
    }
  };
}

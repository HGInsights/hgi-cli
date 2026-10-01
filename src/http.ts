import { EnvHttpProxyAgent, Headers as UndiciHeaders, fetch as undiciFetch, type RequestInit as UndiciInit } from 'undici';
import { USER_AGENT } from './config.js';
import { debug } from './debug.js';
import { HgiError, classifyNetworkError, toHgiError } from './errors.js';

let agent: EnvHttpProxyAgent | undefined;

function dispatcher(): EnvHttpProxyAgent {
  agent ??= new EnvHttpProxyAgent();
  return agent;
}

export type RedirectKind = 'oauth' | 'mcp';

export interface RequestOptions {
  timeoutMs?: number;
  context?: string;
  redirectKind?: RedirectKind;
  signal?: AbortSignal;
}

export const DEFAULT_TIMEOUT_MS = 15_000;

export function proxyFor(target: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const url = new URL(target);
  const noProxy = (env.NO_PROXY ?? env.no_proxy ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const host = url.hostname.toLowerCase();
  if (noProxy.some((h) => h === '*' || host === h || host.endsWith(h.startsWith('.') ? h : `.${h}`))) return undefined;
  const raw =
    url.protocol === 'https:'
      ? (env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy)
      : (env.HTTP_PROXY ?? env.http_proxy);
  if (!raw) return undefined;
  try {
    return new URL(raw).host;
  } catch {
    return raw;
  }
}

export type HttpResponse = Awaited<ReturnType<typeof undiciFetch>>;

export async function httpRequest(
  url: string | URL,
  init: UndiciInit = {},
  opts: RequestOptions = {},
): Promise<HttpResponse> {
  const headers = new UndiciHeaders(init.headers);
  headers.set('User-Agent', USER_AGENT);
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const callerSignals = [opts.signal, init.signal as AbortSignal | null | undefined].filter((x): x is AbortSignal => Boolean(x));
  const signal = callerSignals.length ? AbortSignal.any([timeout, ...callerSignals]) : timeout;
  const target = String(url);
  debug('http', init.method ?? 'GET', target);

  let res: HttpResponse;
  try {
    res = await undiciFetch(target, {
      ...init,
      headers,
      redirect: 'manual',
      dispatcher: dispatcher(),
      signal,
    });
  } catch (err) {
    throw classifyNetworkError(err, opts.context ?? new URL(target).host, proxyFor(target)) ?? toHgiError(err);
  }
  debug('http ->', res.status, target);

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    let host = 'unknown host';
    try {
      if (location) host = new URL(location, target).host;
    } catch {
      // keep "unknown host"
    }
    await res.body?.cancel().catch(() => undefined);
    const message = `Unexpected redirect (${res.status}) from ${new URL(target).host} to ${host}.`;
    if (opts.redirectKind === 'mcp') {
      throw new HgiError('server_unreachable', message, {
        hint: 'Check HGI_BASE_URL points at the canonical host (https://phoenix.hginsights.com).',
        details: { status: res.status, location_host: host },
      });
    }
    throw new HgiError('oauth_error', message, {
      hint: 'hgi never follows redirects on auth requests. Check HGI_BASE_URL.',
      details: { status: res.status, location_host: host },
    });
  }
  return res;
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs;
  const when = Date.parse(value);
  if (Number.isFinite(when)) return Math.max(0, Math.ceil((when - now) / 1000));
  return undefined;
}

export function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function closeHttp(): Promise<void> {
  if (agent) {
    await agent.close().catch(() => undefined);
    agent = undefined;
  }
}

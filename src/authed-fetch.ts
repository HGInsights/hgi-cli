import type { RequestInit as UndiciInit } from 'undici';
import type { TokenManager } from './auth/token-manager.js';
import { HgiError, LOGIN_HINT } from './errors.js';
import { httpRequest, type HttpResponse, type RequestOptions } from './http.js';

export type AuthedFetch = (url: string, init?: UndiciInit, opts?: RequestOptions) => Promise<HttpResponse>;

export function createAuthedFetch(tokens: TokenManager, base: string): AuthedFetch {
  const origin = new URL(base).origin;

  const send = (url: string, init: UndiciInit, token: string, opts: RequestOptions) => {
    const headers = new Headers(init.headers as ConstructorParameters<typeof Headers>[0]);
    headers.set('Authorization', `Bearer ${token}`);
    return httpRequest(url, { ...init, headers: Object.fromEntries(headers.entries()) }, opts);
  };

  return async (url, init = {}, opts = {}) => {
    if (new URL(url).origin !== origin) {
      throw new HgiError('internal_error', 'Refusing to send credentials to a different origin.', {
        details: { reason: 'cross_origin' },
      });
    }
    const token = await tokens.getAccessToken();
    const first = await send(url, init, token, opts);
    if (first.status !== 401) return first;
    await first.body?.cancel().catch(() => undefined);
    const signal = init.signal as AbortSignal | null | undefined;
    if (signal?.aborted) throw signal.reason;

    const fresh = await tokens.forceRefresh(token);
    if (signal?.aborted) throw signal.reason;
    const second = await send(url, init, fresh, opts);
    if (second.status === 401) {
      await second.body?.cancel().catch(() => undefined);
      throw new HgiError('login_expired', 'The server rejected your login again after a refresh.', {
        hint: LOGIN_HINT,
        details: { reason: 'second_401' },
      });
    }
    return second;
  };
}

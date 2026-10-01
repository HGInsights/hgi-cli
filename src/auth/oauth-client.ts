import { clientId, SCOPE } from '../config.js';
import { debug } from '../debug.js';
import { HgiError, LOGIN_HINT } from '../errors.js';
import { httpRequest, parseRetryAfter, sleep, type HttpResponse } from '../http.js';
import { registerSecret } from '../redact.js';

export interface AsMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
  userinfo_endpoint: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
  receivedAt: number;
}

export interface Userinfo {
  user: { id: string; name: string | null; email: string };
  organization: { slug: string; name: string };
  client: { id: string; name: string | null };
}

const ENDPOINT_KEYS = ['authorization_endpoint', 'token_endpoint', 'revocation_endpoint', 'userinfo_endpoint'] as const;

function normalizeIssuer(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase();
}

async function readJson(res: HttpResponse): Promise<Record<string, unknown> | null> {
  try {
    const text = await res.text();
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function discover(base: string): Promise<AsMetadata> {
  const res = await httpRequest(`${base}/.well-known/oauth-authorization-server`, {}, {
    redirectKind: 'oauth',
    context: new URL(base).host,
  });
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    throw new HgiError('oauth_error', `OAuth discovery failed (HTTP ${res.status}).`, {
      hint: 'Check HGI_BASE_URL.',
      details: { status: res.status },
    });
  }
  const body = await readJson(res);
  if (!body || typeof body.issuer !== 'string') {
    throw new HgiError('oauth_error', 'OAuth discovery returned an unexpected document.', {
      details: { reason: 'bad_metadata' },
    });
  }
  if (normalizeIssuer(body.issuer) !== normalizeIssuer(base)) {
    throw new HgiError('oauth_error', `OAuth issuer ${body.issuer} does not match ${base}.`, {
      hint: 'A host the server does not recognise reports its default URL as issuer. Use the canonical host.',
      details: { reason: 'issuer_mismatch' },
    });
  }
  const meta: Partial<Record<(typeof ENDPOINT_KEYS)[number], string>> = {};
  for (const key of ENDPOINT_KEYS) {
    const value = body[key];
    if (typeof value !== 'string') {
      throw new HgiError('oauth_error', `OAuth discovery is missing ${key}.`, { details: { reason: 'bad_metadata' } });
    }
    let origin: string;
    try {
      origin = new URL(value).origin;
    } catch {
      throw new HgiError('oauth_error', `OAuth discovery has an invalid ${key}.`, { details: { reason: 'bad_metadata' } });
    }
    if (origin !== new URL(base).origin) {
      throw new HgiError('oauth_error', `OAuth ${key} points at a different origin (${origin}); refusing to send tokens there.`, {
        details: { reason: 'cross_origin_endpoint' },
      });
    }
    meta[key] = value;
  }
  return { issuer: body.issuer, ...(meta as Record<(typeof ENDPOINT_KEYS)[number], string>) };
}

export function buildAuthorizeUrl(
  meta: AsMetadata,
  base: string,
  args: { redirectUri: string; state: string; challenge: string },
): string {
  const url = new URL(meta.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId(base));
  url.searchParams.set('redirect_uri', args.redirectUri);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('state', args.state);
  url.searchParams.set('code_challenge', args.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

function describe(body: Record<string, unknown> | null): string {
  const error = typeof body?.error === 'string' ? body.error : undefined;
  const description = typeof body?.error_description === 'string' ? body.error_description : undefined;
  return [error, description].filter(Boolean).join(': ');
}

type Grant = 'authorization_code' | 'refresh_token';

async function tokenRequest(
  meta: AsMetadata,
  grant: Grant,
  params: Record<string, string>,
  now: () => number,
): Promise<TokenSet> {
  const form = new URLSearchParams({ grant_type: grant, ...params }).toString();
  for (let attempt = 0; ; attempt += 1) {
    const res = await httpRequest(
      meta.token_endpoint,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: form,
      },
      { redirectKind: 'oauth', context: 'the token endpoint' },
    );
    const receivedAt = now();
    if (res.ok) {
      const body = await readJson(res);
      const access = body?.access_token;
      const refresh = body?.refresh_token;
      const expires = body?.expires_in;
      if (typeof access !== 'string' || typeof refresh !== 'string' || typeof expires !== 'number') {
        throw new HgiError('oauth_error', 'The token endpoint returned an unexpected response.', {
          details: { reason: 'bad_token_response' },
        });
      }
      registerSecret(access);
      registerSecret(refresh);
      return {
        accessToken: access,
        refreshToken: refresh,
        expiresIn: expires,
        scope: typeof body?.scope === 'string' ? body.scope : '',
        receivedAt,
      };
    }

    const body = await readJson(res);
    const error = typeof body?.error === 'string' ? body.error : undefined;
    debug('token endpoint error', res.status, error);

    if (res.status === 429) {
      const retry = parseRetryAfter(res.headers.get('retry-after'));
      throw new HgiError('rate_limited', 'The token endpoint is rate limiting requests.', {
        hint: 'Wait and retry.',
        details: retry === undefined ? undefined : { retry_after_seconds: retry },
      });
    }
    if (error === 'invalid_grant') {
      if (grant === 'refresh_token') {
        throw new HgiError('login_expired', 'Your login has expired or was revoked.', {
          hint: LOGIN_HINT,
          details: { reason: 'invalid_grant' },
        });
      }
      throw new HgiError('oauth_error', `Sign-in code was rejected: ${describe(body) || 'invalid_grant'}.`, {
        hint: 'Run `hgi auth login` again; authorization codes work once.',
        details: { reason: 'invalid_grant' },
      });
    }
    const transient = res.status >= 500 || error === 'server_error' || (res.status === 401 && error === 'invalid_client');
    if (transient && attempt === 0) {
      await sleep(1000);
      continue;
    }
    if (transient) {
      throw new HgiError(
        res.status >= 500 ? 'server_unreachable' : 'oauth_error',
        `The token endpoint is failing temporarily (HTTP ${res.status}${error ? `, ${error}` : ''}).`,
        { hint: 'Your credentials were kept. Try again in a moment.', details: { status: res.status } },
      );
    }
    throw new HgiError('oauth_error', `The token endpoint rejected the request (HTTP ${res.status}): ${describe(body) || 'no detail'}.`, {
      details: { status: res.status, ...(error ? { reason: error } : {}) },
    });
  }
}

export function exchangeCode(
  meta: AsMetadata,
  base: string,
  args: { code: string; verifier: string; redirectUri: string },
  now: () => number = Date.now,
): Promise<TokenSet> {
  return tokenRequest(
    meta,
    'authorization_code',
    {
      code: args.code,
      code_verifier: args.verifier,
      redirect_uri: args.redirectUri,
      client_id: clientId(base),
    },
    now,
  );
}

export function refreshTokens(
  meta: AsMetadata,
  base: string,
  refreshToken: string,
  now: () => number = Date.now,
): Promise<TokenSet> {
  return tokenRequest(meta, 'refresh_token', { refresh_token: refreshToken, client_id: clientId(base) }, now);
}

export async function revokeToken(
  meta: AsMetadata,
  base: string,
  token: string,
  hint: 'access_token' | 'refresh_token',
): Promise<void> {
  const res = await httpRequest(
    meta.revocation_endpoint,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, token_type_hint: hint, client_id: clientId(base) }).toString(),
    },
    { redirectKind: 'oauth', context: 'the revocation endpoint' },
  );
  await res.body?.cancel().catch(() => undefined);
  if (res.ok) return;
  if (res.status === 429) {
    throw new HgiError('rate_limited', 'The revocation endpoint is rate limiting requests.', {
      details: { retry_after_seconds: parseRetryAfter(res.headers.get('retry-after')) },
    });
  }
  throw new HgiError(
    res.status >= 500 ? 'server_unreachable' : 'oauth_error',
    `Token revocation was not accepted (HTTP ${res.status}).`,
    { details: { status: res.status } },
  );
}

export interface UserinfoFetch {
  (url: string): Promise<HttpResponse>;
}

export async function getUserinfo(
  meta: AsMetadata,
  doFetch: UserinfoFetch,
  onUnauthorized: 'oauth' | 'login',
): Promise<Userinfo> {
  const res = await doFetch(meta.userinfo_endpoint);
  if (res.status === 200) {
    const body = await readJson(res);
    const user = body?.user as Record<string, unknown> | undefined;
    const org = body?.organization as Record<string, unknown> | undefined;
    const client = body?.client as Record<string, unknown> | undefined;
    if (!user || !org || typeof user.id !== 'string' || typeof user.email !== 'string' || typeof org.slug !== 'string') {
      throw new HgiError('oauth_error', 'The userinfo endpoint returned an unexpected response.', {
        details: { reason: 'bad_userinfo' },
      });
    }
    return {
      user: { id: user.id, name: typeof user.name === 'string' ? user.name : null, email: user.email },
      organization: { slug: org.slug, name: typeof org.name === 'string' ? org.name : org.slug },
      client: {
        id: typeof client?.id === 'string' ? client.id : '',
        name: typeof client?.name === 'string' ? client.name : null,
      },
    };
  }
  await res.body?.cancel().catch(() => undefined);
  if (res.status === 401) {
    if (onUnauthorized === 'login') {
      throw new HgiError('login_expired', 'Your login has expired or was revoked.', { hint: LOGIN_HINT });
    }
    throw new HgiError('oauth_error', 'The server rejected the freshly issued token.', {
      details: { reason: 'userinfo_401' },
    });
  }
  if (res.status === 403) {
    throw new HgiError('forbidden', 'The server refused the userinfo request (HTTP 403).', { details: { status: 403 } });
  }
  if (res.status === 429) {
    throw new HgiError('rate_limited', 'The userinfo endpoint is rate limiting requests.', {
      details: { retry_after_seconds: parseRetryAfter(res.headers.get('retry-after')) },
    });
  }
  throw new HgiError('server_unreachable', `The userinfo endpoint is unavailable (HTTP ${res.status}).`, {
    hint: 'Retry in a moment.',
    details: { status: res.status, retry_after_seconds: parseRetryAfter(res.headers.get('retry-after')) },
  });
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readCredentials, writeCredentials, type Credentials } from '../../src/auth/credentials-store.js';
import { TokenManager } from '../../src/auth/token-manager.js';
import { getUserinfo, discover, exchangeCode, buildAuthorizeUrl, refreshTokens, revokeToken } from '../../src/auth/oauth-client.js';
import { challengeS256 } from '../../src/auth/pkce.js';
import { createAuthedFetch } from '../../src/authed-fetch.js';
import { HgiError } from '../../src/errors.js';
import { closeHttp } from '../../src/http.js';
import { FakeServer } from '../support/fake-server.js';

const server = new FakeServer();
let dir: string;
let credPath: string;

beforeAll(() => server.start());
afterAll(async () => {
  await closeHttp();
  await server.stop();
});
beforeEach(() => {
  server.reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hgi-tm-'));
  credPath = path.join(dir, 'config', 'credentials-test.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function seed(opts: { ttlSec?: number; expiresAt?: number } = {}): { creds: Credentials; session: { access: string; refresh: string } } {
  const session = server.seedSession(opts.ttlSec ?? 3600);
  const creds: Credentials = {
    version: 1,
    base_url: server.base,
    client_id: `${server.base}/.well-known/oauth-clients/hgi-cli.json`,
    access_token: session.access,
    refresh_token: session.refresh,
    expires_at: opts.expiresAt ?? Date.now() + 3_000_000,
    scope: 'mcp:read mcp:tools offline_access',
    obtained_at: Date.now(),
    user: { id: 'user-1', name: 'Test User', email: 'test@example.com' },
    organization: { slug: 'example-org', name: 'Example Org' },
  };
  writeCredentials(credPath, creds);
  return { creds, session };
}

const manager = (now?: () => number) => new TokenManager({ base: server.base, credPath, now });

describe('refresh deadline and clock skew', () => {
  it('uses the stored token while the local deadline is in the future', async () => {
    const { creds } = seed();
    expect(await manager().getAccessToken()).toBe(creds.access_token);
    expect(server.refreshCalls).toBe(0);
  });

  it('a clock running 10 minutes FAST refreshes early and still works', async () => {
    const { creds } = seed({ expiresAt: Date.now() + 240_000 });
    const token = await manager(() => Date.now() + 600_000).getAccessToken();
    expect(token).not.toBe(creds.access_token);
    expect(server.refreshCalls).toBe(1);
  });

  it('a clock running 10 minutes SLOW holds a server-expired token, and a 401 triggers exactly one refresh', async () => {
    seed({ ttlSec: -1 });
    const tm = manager(() => Date.now() - 600_000);
    const authed = createAuthedFetch(tm, server.base);
    const res = await authed(`${server.base}/oauth/userinfo`);
    expect(res.status).toBe(200);
    expect(server.refreshCalls).toBe(1);
  });

  it('a second 401 after one refresh fails with login_expired and does not loop', async () => {
    seed();
    server.faults.push({ match: { path: '/oauth/userinfo' }, status: 401, body: { error: 'invalid_token' }, times: 10 });
    const authed = createAuthedFetch(manager(), server.base);
    await expect(authed(`${server.base}/oauth/userinfo`)).rejects.toMatchObject({ code: 'login_expired' });
    expect(server.refreshCalls).toBe(1);
  });

  it('a revoked refresh token is login_expired and the file is kept', async () => {
    const { session } = seed({ expiresAt: Date.now() - 1000 });
    server.rows.find((r) => r.refresh === session.refresh)!.revoked = true;
    await expect(manager().getAccessToken()).rejects.toMatchObject({ code: 'login_expired' });
    expect(readCredentials(credPath)).not.toBeNull();
  });
});

describe('parallel refresh (Story 8)', () => {
  it('five managers with an expired access token share ONE refresh and all end with a working login', async () => {
    seed({ expiresAt: Date.now() - 1000 });
    const tokens = await Promise.all(Array.from({ length: 5 }, () => manager().getAccessToken()));
    expect(server.refreshCalls).toBe(1);
    expect(new Set(tokens).size).toBe(1);
    const onDisk = readCredentials(credPath) as Credentials;
    expect(onDisk.access_token).toBe(tokens[0]);
    const row = server.rows.find((r) => r.refresh === onDisk.refresh_token);
    expect(row && !row.revoked).toBe(true);
  });

  it('a stale in-memory token adopts the newer on-disk token instead of refreshing again', async () => {
    const { creds } = seed({ expiresAt: Date.now() - 1000 });
    const winner = await manager().getAccessToken();
    const adopted = await manager().forceRefresh(creds.access_token);
    expect(adopted).toBe(winner);
    expect(server.refreshCalls).toBe(1);
  });
});

describe('a lock lost during a refresh', () => {
  it('does not save, revokes the freshly rotated pair, and reports lock_compromised', async () => {
    const { creds } = seed({ expiresAt: Date.now() - 1000 });
    server.onRefresh = () => fs.writeFileSync(`${credPath}.lock-owner`, 'a-newer-holder');
    try {
      await expect(manager().getAccessToken()).rejects.toMatchObject({ code: 'local_state_error', details: { kind: 'lock_compromised' } });
    } finally {
      server.onRefresh = null;
    }
    expect(readCredentials(credPath)?.access_token).toBe(creds.access_token);
    const rotated = server.rows[server.rows.length - 1];
    expect(rotated?.access).not.toBe(creds.access_token);
    expect(rotated?.revoked).toBe(true);
  });
});

describe('missing credentials', () => {
  it('after logout a refresh never reaches the network and reports login_required', async () => {
    const { creds } = seed({ expiresAt: Date.now() - 1000 });
    fs.rmSync(credPath);
    await expect(manager().forceRefresh(creds.access_token)).rejects.toMatchObject({ code: 'login_required' });
    expect(server.requests.some((r) => r.path === '/oauth/token')).toBe(false);
  });

  it('credentials for another base are not used', async () => {
    const { creds } = seed();
    writeCredentials(credPath, { ...creds, base_url: 'https://other.example' });
    await expect(manager().getAccessToken()).rejects.toMatchObject({ code: 'login_required' });
  });
});

describe('oauth client against the fake server', () => {
  async function newCode(): Promise<{ code: string; verifier: string; redirectUri: string }> {
    const meta = await discover(server.base);
    const verifier = 'v'.repeat(43);
    const redirectUri = 'http://127.0.0.1:50000/callback';
    const url = buildAuthorizeUrl(meta, server.base, { redirectUri, state: 's', challenge: challengeS256(verifier) });
    const res = await fetch(url, { redirect: 'manual' });
    const code = new URL(res.headers.get('location') as string).searchParams.get('code') as string;
    return { code, verifier, redirectUri };
  }

  it('exchanges a code once; a reused code, bad verifier and wrong redirect URI are oauth_error (not login_expired)', async () => {
    const meta = await discover(server.base);
    const first = await newCode();
    const tokens = await exchangeCode(meta, server.base, first);
    expect(tokens.accessToken).toMatch(/^at_/);
    await expect(exchangeCode(meta, server.base, first)).rejects.toMatchObject({ code: 'oauth_error', details: { reason: 'invalid_grant' } });
    const second = await newCode();
    await expect(exchangeCode(meta, server.base, { ...second, verifier: 'w'.repeat(43) })).rejects.toMatchObject({ code: 'oauth_error' });
    const third = await newCode();
    await expect(exchangeCode(meta, server.base, { ...third, redirectUri: 'http://127.0.0.1:50001/callback' })).rejects.toMatchObject({ code: 'oauth_error' });
  });

  it('refresh with a replayed (rotated-away) token is login_expired', async () => {
    const meta = await discover(server.base);
    const { refresh } = server.seedSession();
    await refreshTokens(meta, server.base, refresh);
    await expect(refreshTokens(meta, server.base, refresh)).rejects.toMatchObject({ code: 'login_expired' });
  });

  it('revoke makes both tokens fail', async () => {
    const meta = await discover(server.base);
    const { access, refresh } = server.seedSession();
    await revokeToken(meta, server.base, access, 'access_token');
    await expect(refreshTokens(meta, server.base, refresh)).rejects.toMatchObject({ code: 'login_expired' });
    const res = await fetch(`${server.base}/oauth/userinfo`, { headers: { authorization: `Bearer ${access}` } });
    expect(res.status).toBe(401);
  });

  it('a token endpoint server_error keeps credentials and is retried once, then reported as try-again, not login', async () => {
    const meta = await discover(server.base);
    const { refresh } = server.seedSession();
    server.faults.push({ match: { path: '/oauth/token' }, status: 400, body: { error: 'server_error' }, times: 2 });
    const started = Date.now();
    await expect(refreshTokens(meta, server.base, refresh)).rejects.toMatchObject({ code: 'oauth_error' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(server.requests.filter((r) => r.path === '/oauth/token')).toHaveLength(2);
  });

  it('401 invalid_client from the token endpoint (CIMD hiccup) is oauth_error, never login_expired', async () => {
    const meta = await discover(server.base);
    const { refresh } = server.seedSession();
    server.faults.push({ match: { path: '/oauth/token' }, status: 401, body: { error: 'invalid_client' }, times: 2 });
    await expect(refreshTokens(meta, server.base, refresh)).rejects.toMatchObject({ code: 'oauth_error' });
  });

  it('refuses discovery whose issuer or endpoints do not match the base', async () => {
    server.issuerOverride = 'https://phoenix.hginsights.com';
    try {
      await expect(discover(server.base)).rejects.toMatchObject({ code: 'oauth_error', details: { reason: 'issuer_mismatch' } });
    } finally {
      server.issuerOverride = null;
    }
  });

  it('never follows a redirect on a token request', async () => {
    const meta = await discover(server.base);
    const { refresh } = server.seedSession();
    server.redirectTokenPost = true;
    try {
      await expect(refreshTokens(meta, server.base, refresh)).rejects.toMatchObject({ code: 'oauth_error', details: { location_host: 'evil.example' } });
    } finally {
      server.redirectTokenPost = false;
    }
  });

  it('userinfo maps 429 and 503 distinctly', async () => {
    const meta = await discover(server.base);
    const { access } = server.seedSession();
    const doFetch = (url: string) => fetch(url, { headers: { authorization: `Bearer ${access}` } }) as never;
    server.faults.push({ match: { path: '/oauth/userinfo' }, status: 429, headers: { 'retry-after': '3' }, times: 1 });
    await expect(getUserinfo(meta, doFetch, 'oauth')).rejects.toMatchObject({ code: 'rate_limited', details: { retry_after_seconds: 3 } });
    server.faults.push({ match: { path: '/oauth/userinfo' }, status: 503, times: 1 });
    await expect(getUserinfo(meta, doFetch, 'oauth')).rejects.toBeInstanceOf(HgiError);
  });
});

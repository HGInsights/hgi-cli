import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { credentialsFile, makeSandbox, readCreds, runCli, startCli, type Sandbox } from '../support/cli.js';
import { errorBody, expireAccessToken, login, seedServer } from '../support/e2e.js';
import { FakeServer } from '../support/fake-server.js';

const server = new FakeServer();
let sb: Sandbox;

beforeAll(() => server.start());
afterAll(() => server.stop());
beforeEach(() => {
  seedServer(server);
  sb = makeSandbox(server.base);
});
afterEach(() => sb.cleanup());

async function userinfo(token: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${server.base}/oauth/userinfo`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('Story 1: sign in once', () => {
  it('login stores a 0600 credentials file and whoami matches the server userinfo', async () => {
    await login(sb);
    const file = credentialsFile(sb);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(sb.configDir).mode & 0o777).toBe(0o700);

    const who = await runCli(['auth', 'whoami'], sb.env);
    expect(who.code, who.stderr).toBe(0);
    const shown = JSON.parse(who.stdout) as { user: unknown; organization: unknown };
    const direct = await userinfo(readCreds(sb).access_token);
    expect(shown.user).toEqual(direct.body.user);
    expect(shown.organization).toEqual(direct.body.organization);
  });

  it('a call made after the access token expired succeeds without signing in again', async () => {
    await login(sb);
    const before = readCreds(sb);
    expireAccessToken(sb);
    const call = await runCli(['call', 'company_lookup', '--input', '{"domain":"acme.com"}'], sb.env);
    expect(call.code, call.stderr).toBe(0);
    expect(server.refreshCalls).toBe(1);
    expect(readCreds(sb).refresh_token).not.toBe(before.refresh_token);
  });

  it('the credentials file lives under ~/.config/hgi by default, never in the working directory', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hgi-home-'));
    const env: NodeJS.ProcessEnv = { ...sb.env, HOME: home };
    delete env.HGI_CONFIG_DIR;
    delete env.HGI_CACHE_DIR;
    try {
      const res = await runCli(['auth', 'login'], env);
      expect(res.code, res.stderr).toBe(0);
      const files = fs.readdirSync(path.join(home, '.config', 'hgi'));
      expect(files.some((f) => f.startsWith('credentials-'))).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('Story 7: sign in without a local browser', () => {
  async function startNoBrowser() {
    const live = startCli(['auth', 'login', '--no-browser'], sb.env);
    const url = await live.waitForStderr(/(http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\S+)/);
    const res = await fetch(url, { redirect: 'manual' });
    const callback = res.headers.get('location') as string;
    return { live, callback, authorizeUrl: url };
  }

  it('prints a URL and a pasted callback URL yields a working login', async () => {
    const { live, callback } = await startNoBrowser();
    live.write(`${callback}\n`);
    const res = await live.result();
    expect(res.code, res.stderr).toBe(0);
    const who = await runCli(['auth', 'whoami'], sb.env);
    expect(who.code, who.stderr).toBe(0);
  });

  it('the redirect URI names localhost, not the literal 127.0.0.1 that the front door 403s in query strings', async () => {
    const live = startCli(['auth', 'login', '--no-browser'], sb.env);
    const url = await live.waitForStderr(/(http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\S+)/);
    const redirect = new URL(url).searchParams.get('redirect_uri') as string;
    expect(redirect).toMatch(/^http:\/\/localhost:\d+\/callback$/);
    const params = new URL(url).searchParams;
    params.delete('client_id'); // the fake server's own base URL is 127.0.0.1; real hosts are names
    expect(params.toString()).not.toContain('127.0.0.1');
    live.child.stdin?.end();
    await live.result();
  });

  it('rejects a wrong state and stores nothing', async () => {
    const { live, callback } = await startNoBrowser();
    const bad = callback.replace(/state=[^&]+/, 'state=forged');
    live.write(`${bad}\n`);
    const res = await live.result();
    expect(res.code).toBe(8);
    expect(errorBody(res).error.details?.reason).toBe('state_mismatch');
    expect(fs.existsSync(sb.configDir) && fs.readdirSync(sb.configDir).some((f) => f.startsWith('credentials-'))).toBe(false);
    expect(server.requests.some((r) => r.path === '/oauth/token')).toBe(false);
  });

  it('rejects a wrong redirect URI before contacting the token endpoint', async () => {
    const { live, callback } = await startNoBrowser();
    live.write(`${callback.replace(/localhost:\d+/, 'localhost:1')}\n`);
    const res = await live.result();
    expect(res.code).toBe(8);
    expect(errorBody(res).error.details?.reason).toBe('redirect_mismatch');
    expect(server.requests.some((r) => r.path === '/oauth/token')).toBe(false);
  });

  it('a code that was already used is rejected by the server (exit 8, not login_expired)', async () => {
    const first = await startNoBrowser();
    const firstCode = new URL(first.callback).searchParams.get('code') as string;
    first.live.write(`${first.callback}\n`);
    expect((await first.live.result()).code).toBe(0);

    const second = await startNoBrowser();
    const u = new URL(second.callback);
    u.searchParams.set('code', firstCode);
    second.live.write(`${u.toString()}\n`);
    const res = await second.live.result();
    expect(res.code).toBe(8);
    expect(errorBody(res).error.details?.reason).toBe('invalid_grant');
  });

  it('exits 8 when stdin closes without a callback URL', async () => {
    const live = startCli(['auth', 'login', '--no-browser'], sb.env);
    await live.waitForStderr(/Paste the callback URL/);
    live.child.stdin?.end();
    expect((await live.result()).code).toBe(8);
  });
});

describe('Story 8: parallel commands do not log the user out', () => {
  it('five parallel calls with an expired access token all succeed, share one refresh, and leave a working refresh token', async () => {
    await login(sb);
    expireAccessToken(sb);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => runCli(['call', 'company_lookup', '--input', '{"domain":"acme.com"}'], sb.env)),
    );
    for (const r of results) expect(r.code, r.stderr).toBe(0);
    expect(server.refreshCalls).toBe(1);
    const creds = readCreds(sb);
    const row = server.rows.find((r) => r.refresh === creds.refresh_token);
    expect(row && !row.revoked).toBe(true);
    const after = await runCli(['auth', 'whoami'], sb.env);
    expect(after.code, after.stderr).toBe(0);
  });
});

describe('Story 9: tokens do not leak; logout revokes', () => {
  it('no token appears in any output or debug log of a full session; logout revokes both tokens and removes the file', async () => {
    const outputs: string[] = [];
    const run = async (args: string[], input?: string) => {
      const r = await runCli(['--debug', ...args], sb.env, { input });
      outputs.push(r.stdout, r.stderr);
      return r;
    };
    expect((await run(['auth', 'login'])).code).toBe(0);
    const captured = readCreds(sb);
    expect((await run(['auth', 'whoami'])).code).toBe(0);
    expect((await run(['tools', 'list', '--json'])).code).toBe(0);
    expect((await run(['call', 'company_lookup', '--input', '{"domain":"acme.com"}'])).code).toBe(0);
    expireAccessToken(sb);
    expect((await run(['call', 'company_lookup', '--input', '{"domain":"acme.com"}'])).code).toBe(0);
    const rotated = readCreds(sb);
    const tokens = [captured.access_token, captured.refresh_token, rotated.access_token, rotated.refresh_token];

    const logout = await run(['auth', 'logout']);
    expect(logout.code, logout.stderr).toBe(0);
    expect(fs.readdirSync(sb.configDir).filter((f) => f.startsWith('credentials-'))).toEqual([]);

    const all = outputs.join('\n');
    for (const t of tokens) expect(all).not.toContain(t);
    for (const file of fs.readdirSync(sb.cacheDir)) {
      const text = fs.readFileSync(path.join(sb.cacheDir, file), 'utf8');
      for (const t of tokens) expect(text).not.toContain(t);
    }

    const replayRefresh = await fetch(`${server.base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rotated.refresh_token }),
    });
    expect(replayRefresh.status).toBe(400);
    expect(((await replayRefresh.json()) as { error: string }).error).toBe('invalid_grant');
    expect((await userinfo(rotated.access_token)).status).toBe(401);
    const mcp = await fetch(`${server.base}/api/ai/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${rotated.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(mcp.status).toBe(401);
  });

  it('a server that echoes the token in an error message cannot make hgi print it', async () => {
    await login(sb);
    const token = readCreds(sb).access_token;
    server.handlers.set('company_lookup', (args) => ({
      isError: true,
      content: [{ type: 'text', text: `bad domain ${String(args.domain)} for Bearer ${token}` }],
    }));
    const res = await runCli(['--debug', 'call', 'company_lookup', '--input', JSON.stringify({ domain: token })], sb.env);
    expect(res.code).toBe(3);
    expect(res.stdout + res.stderr).not.toContain(token);
  });

  it('logout keeps the credentials and exits 7 when the revoke cannot be delivered; --force deletes with a warning', async () => {
    await login(sb);
    server.faults.push({ match: { path: '/oauth/revoke' }, status: 503, times: 10 });
    const res = await runCli(['auth', 'logout'], sb.env);
    expect(res.code).toBe(7);
    expect(errorBody(res).error.message).toContain('NOT signed out');
    expect(fs.existsSync(credentialsFile(sb))).toBe(true);
    const forced = await runCli(['auth', 'logout', '--force'], sb.env);
    expect(forced.code).toBe(0);
    expect(forced.stderr).toContain('may stay valid');
    expect(fs.readdirSync(sb.configDir).filter((f) => f.startsWith('credentials-'))).toEqual([]);
  });

  it('logout when not signed in is a no-op success', async () => {
    const res = await runCli(['auth', 'logout'], sb.env);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).result).toBe('not_signed_in');
  });
});

describe('PKCE verifier hygiene', () => {
  it('a server that reflects the code_verifier without a label cannot make hgi print it', async () => {
    server.echoVerifierOnCodeExchange = true;
    try {
      const res = await runCli(['auth', 'login'], sb.env);
      expect(res.code).toBe(8);
      expect(server.lastVerifier.length).toBeGreaterThan(40);
      expect(res.stdout + res.stderr).not.toContain(server.lastVerifier);
      expect(res.stderr).toContain('[REDACTED]');
    } finally {
      server.echoVerifierOnCodeExchange = false;
    }
  });
});

describe('login lifecycle', () => {
  it('a repeat login revokes the previous session', async () => {
    await login(sb);
    const old = readCreds(sb);
    await login(sb);
    expect(readCreds(sb).refresh_token).not.toBe(old.refresh_token);
    const replay = await fetch(`${server.base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: old.refresh_token }),
    });
    expect(replay.status).toBe(400);
  });

  it('succeeds with a warning when the old session cannot be revoked', async () => {
    await login(sb);
    server.faults.push({ match: { path: '/oauth/revoke' }, status: 503, times: 4 });
    const res = await runCli(['auth', 'login'], sb.env);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stderr).toContain('previous session was not revoked');
  });

  it('recovers from a corrupt credentials file by overwriting it', async () => {
    fs.mkdirSync(sb.configDir, { recursive: true });
    const file = path.join(sb.configDir, `credentials-${new URL(server.base).hostname}-${new URL(server.base).port}.json`);
    fs.writeFileSync(file, '{garbage', { mode: 0o600 });
    const res = await runCli(['auth', 'login'], sb.env);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stderr).toContain('replaced an unreadable credentials file');
    expect(readCreds(sb).access_token).toMatch(/^at_/);
  });

  it('recovers from a wrong-mode credentials file and revokes the old pair', async () => {
    await login(sb);
    const old = readCreds(sb);
    fs.chmodSync(credentialsFile(sb), 0o644);
    const res = await runCli(['auth', 'login'], sb.env);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stderr).toContain('readable by other users');
    expect(fs.statSync(credentialsFile(sb)).mode & 0o777).toBe(0o600);
    expect(server.rows.find((r) => r.refresh === old.refresh_token)?.revoked).toBe(true);
  });

  it('refuses a symlink at the credentials path before opening a browser, leaving its target untouched', async () => {
    fs.mkdirSync(sb.configDir, { recursive: true });
    const target = path.join(sb.dir, 'victim.txt');
    fs.writeFileSync(target, 'precious');
    const link = path.join(sb.configDir, `credentials-${new URL(server.base).hostname}-${new URL(server.base).port}.json`);
    fs.symlinkSync(target, link);
    const res = await runCli(['auth', 'login'], sb.env);
    expect(res.code).toBe(12);
    expect(errorBody(res).error.details).toMatchObject({ kind: 'credentials_unsafe', reason: 'symlink' });
    expect(fs.readFileSync(target, 'utf8')).toBe('precious');
    expect(server.requests.some((r) => r.path === '/oauth/authorize')).toBe(false);
  });

  it('when userinfo fails after the code exchange, the new session is revoked and old credentials stay usable', async () => {
    await login(sb);
    const old = readCreds(sb);
    server.userinfoStatus = 503;
    const res = await runCli(['auth', 'login'], sb.env);
    server.userinfoStatus = null;
    expect(res.code).toBe(7);
    expect(readCreds(sb).refresh_token).toBe(old.refresh_token);
    const live = server.rows.filter((r) => !r.revoked);
    expect(live.map((r) => r.refresh)).toEqual([old.refresh_token]);
    expect((await runCli(['auth', 'whoami'], sb.env)).code).toBe(0);
  });
});

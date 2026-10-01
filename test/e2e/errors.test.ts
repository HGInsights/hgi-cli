import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { credentialsFile, makeSandbox, runCli, type CliResult, type Sandbox } from '../support/cli.js';
import { errorBody, expireAccessToken, login, seedServer } from '../support/e2e.js';
import { FakeServer, closedPort, textResult } from '../support/fake-server.js';

const server = new FakeServer();
let sb: Sandbox;

beforeAll(() => server.start());
afterAll(() => server.stop());
beforeEach(() => {
  seedServer(server);
  sb = makeSandbox(server.base);
});
afterEach(() => sb.cleanup());

const lookup = (input = '{"domain":"acme.com"}', args: string[] = []) =>
  runCli(['call', 'company_lookup', '--input', input, ...args], sb.env);

function expectError(res: CliResult, exit: number, code: string): ReturnType<typeof errorBody>['error'] {
  expect(res.code, res.stderr).toBe(exit);
  const { schema, error } = errorBody(res);
  expect(schema).toBe(1);
  expect(error.exit_code).toBe(exit);
  expect(error.code).toBe(code);
  expect(res.stdout).toBe('');
  return error;
}

describe('Story 5: every failure has its own exit code and a stable JSON error', () => {
  describe('exit 2 invalid_input', () => {
    beforeEach(() => login(sb));
    it('malformed JSON input', async () => {
      const err = expectError(await lookup('{nope'), 2, 'invalid_input');
      expect(err.details?.reason).toBe('invalid_json');
    });
    it('input that is not an object', async () => {
      expectError(await lookup('[1,2]'), 2, 'invalid_input');
    });
    it('input that violates the tool schema, with the path in details', async () => {
      const err = expectError(await lookup('{"limit":"ten"}'), 2, 'invalid_input');
      expect(err.details?.reason).toBe('schema');
      expect(JSON.stringify(err.details?.errors)).toContain("required property 'domain'");
      expect(server.toolCalls()).toHaveLength(0);
    });
    it('unknown tool, with suggestions', async () => {
      const res = await runCli(['call', 'company', '--input', '{}'], sb.env);
      const err = expectError(res, 2, 'invalid_input');
      expect(err.details?.reason).toBe('unknown_tool');
      expect(err.details?.suggestions).toEqual(['company_lookup']);
    });
    it('usage errors (unknown option, missing argument, unknown command)', async () => {
      expectError(await runCli(['call', 'company_lookup', '--bogus'], sb.env), 2, 'invalid_input');
      expectError(await runCli(['call'], sb.env), 2, 'invalid_input');
      expectError(await runCli(['frobnicate'], sb.env), 2, 'invalid_input');
    });
    it('a bad --timeout is invalid_input on call, run and tools list (never exit 1)', async () => {
      for (const args of [['tools', 'list', '--timeout', 'abc'], ['call', 'company_lookup', '--input', '{}', '--timeout', '-5'], ['run', 'start_agent', '--input', '{}', '--timeout', '0']]) {
        const err = expectError(await runCli(args, sb.env), 2, 'invalid_input');
        expect(err.details?.reason).toBe('bad_timeout');
      }
    });
    it('--help and --version exit 0', async () => {
      expect((await runCli(['--help'], sb.env)).code).toBe(0);
      expect((await runCli(['--version'], sb.env)).stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  describe('exit 3 tool_error', () => {
    beforeEach(() => login(sb));
    it('HTTP 200 with isError', async () => {
      server.handlers.set('company_lookup', () => ({ isError: true, content: [{ type: 'text', text: 'Error executing company_lookup: boom' }] }));
      const err = expectError(await lookup(), 3, 'tool_error');
      expect(err.message).toContain('boom');
      expect(err.details?.tool).toBe('company_lookup');
    });
    it('a JSON-RPC error from the server', async () => {
      server.faults.push({ match: { rpcMethod: 'tools/call' }, status: 200, rpcError: { code: -32602, message: 'bad params' }, times: 1 });
      const err = expectError(await lookup(), 3, 'tool_error');
      expect(err.details?.jsonrpc_code).toBe(-32602);
    });
  });

  describe('exit 4 login required / expired', () => {
    it('not signed in', async () => {
      const err = expectError(await lookup(), 4, 'login_required');
      expect(err.hint).toContain('hgi auth login');
    });
    it('refresh token revoked server-side: login_expired, message says to run hgi auth login, credentials kept', async () => {
      await login(sb);
      server.rows.forEach((r) => (r.revoked = true));
      const err = expectError(await lookup(), 4, 'login_expired');
      expect(err.hint).toContain('hgi auth login');
      expect(fs.existsSync(credentialsFile(sb))).toBe(true);
    });
    it('expired locally and revoked: login_expired without looping', async () => {
      await login(sb);
      expireAccessToken(sb);
      server.rows.forEach((r) => (r.revoked = true));
      expectError(await lookup(), 4, 'login_expired');
      expect(server.refreshCalls).toBe(1);
    });
    it('a second 401 after one refresh fails with login_expired and refreshes exactly once', async () => {
      await login(sb);
      server.faults.push({ match: { path: '/api/ai/mcp' }, status: 401, body: { jsonrpc: '2.0', error: { code: -32603, message: 'Unauthorized' }, id: null }, times: 20 });
      const err = expectError(await lookup(), 4, 'login_expired');
      expect(err.details?.reason).toBe('second_401');
      expect(server.refreshCalls).toBe(1);
    });
    it('a token the server expired while the local clock thought it valid refreshes once and succeeds', async () => {
      await login(sb);
      server.rows.forEach((r) => (r.accessExpiresAt = Date.now() - 1000));
      const res = await lookup();
      expect(res.code, res.stderr).toBe(0);
      expect(server.refreshCalls).toBe(1);
    });
  });

  describe('exit 5 rate_limited', () => {
    beforeEach(() => login(sb));
    it('honors Retry-After, then succeeds', async () => {
      server.faults.push({ match: { rpcMethod: 'tools/call' }, status: 429, headers: { 'retry-after': '1' }, body: { error: 'Rate limit exceeded' }, times: 1 });
      const started = Date.now();
      const res = await lookup();
      expect(res.code, res.stderr).toBe(0);
      expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
      expect(server.toolCalls()).toHaveLength(2);
    });
    it('gives up after bounded retries with retry_after_seconds in the error', async () => {
      server.faults.push({ match: { rpcMethod: 'tools/call' }, status: 429, headers: { 'retry-after': '1' }, body: { error: 'Rate limit exceeded' }, times: 50 });
      const err = expectError(await lookup(), 5, 'rate_limited');
      expect(err.details?.retry_after_seconds).toBe(1);
      expect(server.toolCalls()).toHaveLength(4);
    });
    it('fails fast when Retry-After is longer than the retry budget', async () => {
      server.faults.push({ match: { rpcMethod: 'tools/call' }, status: 429, headers: { 'retry-after': '300' }, body: {}, times: 50 });
      const started = Date.now();
      const err = expectError(await lookup(), 5, 'rate_limited');
      expect(err.details?.retry_after_seconds).toBe(300);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(server.toolCalls()).toHaveLength(1);
    });
  });

  describe('exit 6 credit_limit_exceeded', () => {
    beforeEach(() => login(sb));
    it('is decided by _meta.errorCode, not by prose', async () => {
      server.handlers.set('company_lookup', () => ({
        isError: true,
        content: [{ type: 'text', text: 'Credit limit reached. Do not retry this tool call.' }],
        _meta: { errorCode: 'credit_limit_exceeded' },
      }));
      expectError(await lookup(), 6, 'credit_limit_exceeded');
      server.handlers.set('company_lookup', () => ({
        isError: true,
        content: [{ type: 'text', text: 'credit_limit_exceeded: Do not retry this tool call.' }],
      }));
      expectError(await lookup(), 3, 'tool_error');
    });
  });

  describe('exit 7 server_unreachable', () => {
    it('nothing listens at the base URL', async () => {
      const dead = makeSandbox(`http://127.0.0.1:${await closedPort()}`);
      try {
        const res = await runCli(['auth', 'login'], dead.env);
        const err = expectError(res, 7, 'server_unreachable');
        expect(err.message).toContain('ECONNREFUSED');
      } finally {
        dead.cleanup();
      }
    });
    it('a connection dropped mid tools/call is never retried and reports outcome_unknown', async () => {
      await login(sb);
      server.faults.push({ match: { rpcMethod: 'tools/call' }, status: 0, destroy: true, times: 5 });
      const err = expectError(await runCli(['run', 'start_agent', '--input', '{"agent":"a"}'], sb.env), 7, 'server_unreachable');
      expect(err.details?.outcome_unknown).toBe(true);
      expect(server.toolCalls()).toHaveLength(1);
    });
    it('a connection that drops while the response body is streaming is outcome_unknown and not retried', async () => {
      await login(sb);
      server.faults.push({ match: { rpcMethod: 'tools/call' }, status: 200, truncate: true, times: 5 });
      const err = expectError(await runCli(['run', 'start_agent', '--input', '{"agent":"a"}'], sb.env), 7, 'server_unreachable');
      expect(err.details?.outcome_unknown).toBe(true);
      expect(server.toolCalls()).toHaveLength(1);
    });
    it('a 500 after tools/call was written is never retried and reports outcome_unknown', async () => {
      await login(sb);
      server.faults.push({ match: { rpcMethod: 'tools/call' }, status: 500, body: { error: 'boom' }, times: 5 });
      const err = expectError(await runCli(['run', 'start_agent', '--input', '{"agent":"a"}'], sb.env), 7, 'server_unreachable');
      expect(err.details?.outcome_unknown).toBe(true);
      expect(server.toolCalls()).toHaveLength(1);
    });
    it("Phoenix's pre-dispatch 503 shed is retried and then succeeds", async () => {
      await login(sb);
      server.faults.push({
        match: { rpcMethod: 'tools/call' },
        status: 503,
        headers: { 'retry-after': '1' },
        body: { jsonrpc: '2.0', error: { code: -32000, message: 'Server busy' }, id: null },
        times: 1,
      });
      const res = await runCli(['run', 'start_agent', '--input', '{"agent":"a"}'], sb.env);
      expect(res.code, res.stderr).toBe(0);
      expect(server.toolCalls()).toHaveLength(2);
    });
    it('a redirect from the MCP endpoint is rejected and names the target host', async () => {
      await login(sb);
      server.faults.push({ match: { path: '/api/ai/mcp' }, status: 307, headers: { location: 'https://elsewhere.example/api/ai/mcp' }, times: 5 });
      const err = expectError(await lookup(), 7, 'server_unreachable');
      expect(err.details?.location_host).toBe('elsewhere.example');
    });
  });

  describe('exit 8 oauth_error', () => {
    it('an issuer that does not match the base URL is refused', async () => {
      server.issuerOverride = 'https://phoenix.hginsights.com';
      try {
        const err = expectError(await runCli(['auth', 'login'], sb.env), 8, 'oauth_error');
        expect(err.details?.reason).toBe('issuer_mismatch');
      } finally {
        server.issuerOverride = null;
      }
    });
    it('a redirect on the token endpoint is never followed (refresh token is not replayed elsewhere)', async () => {
      await login(sb);
      expireAccessToken(sb);
      server.redirectTokenPost = true;
      try {
        const err = expectError(await lookup(), 8, 'oauth_error');
        expect(err.details?.location_host).toBe('evil.example');
      } finally {
        server.redirectTokenPost = false;
      }
    });
    it('consent denied in the browser', async () => {
      const env = { ...sb.env, BROWSER: `${process.execPath} ${path.resolve('test/support/deny-browser.mjs')}` };
      const err = expectError(await runCli(['auth', 'login'], env), 8, 'oauth_error');
      expect(err.message).toContain('denied');
    });
  });

  describe('exit 9 network_proxy_tls', () => {
    it('names a TLS verification failure', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hgi-tls-'));
      try {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
        const tls = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (_req, res) => res.end('{}'));
        await new Promise<void>((r) => tls.listen(0, '127.0.0.1', r));
        const port = (tls.address() as AddressInfo).port;
        const secure = makeSandbox(`https://localhost:${port}`);
        try {
          const err = expectError(await runCli(['auth', 'login'], secure.env), 9, 'network_proxy_tls');
          expect(err.message).toMatch(/TLS verification failed.*(SELF_SIGNED|UNABLE_TO_VERIFY|CERT)/);
          expect(err.hint).toContain('NODE_EXTRA_CA_CERTS');
        } finally {
          secure.cleanup();
          tls.closeAllConnections();
          await new Promise<void>((r) => tls.close(() => r()));
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
    it('names an unreachable proxy', async () => {
      const proxied = makeSandbox('https://hgi.example.invalid', { HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '' });
      try {
        const err = expectError(await runCli(['auth', 'login'], proxied.env), 9, 'network_proxy_tls');
        expect(err.message).toContain('proxy');
        expect(err.details).toMatchObject({ proxy: '127.0.0.1:9' });
      } finally {
        proxied.cleanup();
      }
    });
  });

  describe('exit 11 forbidden', () => {
    it('HTTP 403 from the MCP endpoint', async () => {
      await login(sb);
      server.faults.push({ match: { path: '/api/ai/mcp' }, status: 403, body: { error: 'forbidden' }, times: 5 });
      expectError(await lookup(), 11, 'forbidden');
    });
  });

  describe('exit 12 local_state_error', () => {
    it('a corrupt credentials file', async () => {
      await login(sb);
      fs.writeFileSync(credentialsFile(sb), '{broken', { mode: 0o600 });
      const err = expectError(await runCli(['auth', 'whoami'], sb.env), 12, 'local_state_error');
      expect(err.details?.kind).toBe('credentials_corrupt');
      expect(err.hint).toContain('hgi auth login');
    });
    it('a credentials file readable by others', async () => {
      await login(sb);
      fs.chmodSync(credentialsFile(sb), 0o644);
      const err = expectError(await lookup(), 12, 'local_state_error');
      expect(err.details?.kind).toBe('credentials_unsafe');
    });
  });

  describe('workspace guard (overrides only)', () => {
    it('refuses a config dir override inside a git working tree, but not outside', async () => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hgi-repo-'));
      try {
        execFileSync('git', ['init', '-q'], { cwd: repo });
        const inside = { ...sb.env, HGI_CONFIG_DIR: path.join(repo, '.hgi') };
        const err = expectError(await runCli(['auth', 'whoami'], inside, { cwd: repo }), 2, 'invalid_input');
        expect(err.details?.reason).toBe('workspace_guard');
        const outside = await runCli(['auth', 'logout'], sb.env, { cwd: repo });
        expect(outside.code, outside.stderr).toBe(0);
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  describe('the error body', () => {
    it('is plain text with a hint when --json-errors is off and stderr is a TTY is covered by the renderer; here: JSON always carries schema, code, exit_code, message', async () => {
      const res = await runCli(['--json-errors', 'call', 'x'], sb.env);
      const { schema, error } = errorBody(res);
      expect(schema).toBe(1);
      expect(Object.keys(error)).toEqual(expect.arrayContaining(['code', 'exit_code', 'message']));
    });
    it('unexpected thrown errors never print a stack trace or exit 0', async () => {
      await login(sb);
      server.handlers.set('company_lookup', () => textResult({ ok: true }, 1));
      server.faults.push({ match: { rpcMethod: 'initialize' }, status: 200, body: 'not json at all', times: 5 });
      const res = await lookup();
      expect(res.code).not.toBe(0);
      expect(res.stderr).not.toMatch(/\n\s+at .*\(.*:\d+:\d+\)/);
    });
  });
});

describe('package metadata', () => {
  it('refuses Windows installs and requires a supported Node', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { os: string[]; engines: { node: string }; bin: Record<string, string> };
    expect(pkg.os).toEqual(['darwin', 'linux']);
    expect(pkg.engines.node).toBe('>=22.19.0');
    expect(pkg.bin.hgi).toBe('dist/bin.js');
  });
});

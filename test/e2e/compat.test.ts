import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeSandbox, runCli, type Sandbox } from '../support/cli.js';
import { errorBody, login, seedServer } from '../support/e2e.js';
import { FakeServer, READ_TOOL, textResult, type FakeTool } from '../support/fake-server.js';

// docs/compatibility.md: the CLI builds its command surface from the server's tool list at run time,
// so a server tool-set change needs no CLI release. One CLI build is run against two server tool sets.
const server = new FakeServer();
let sb: Sandbox;

beforeAll(() => server.start());
afterAll(() => server.stop());
beforeEach(async () => {
  seedServer(server);
  sb = makeSandbox(server.base);
  await login(sb);
});
afterEach(() => sb.cleanup());

const call = (tool: string, input = '{"domain":"acme.com"}') => runCli(['call', tool, '--input', input], sb.env);
const toolNames = async (extra: string[] = []) =>
  (JSON.parse((await runCli(['tools', 'list', '--json', ...extra], sb.env)).stdout) as { tools: Array<{ name: string }> }).tools.map((t) => t.name);

describe('server tool-set changes need no CLI release', () => {
  it('a tool added on the server is callable with no prior refresh', async () => {
    await toolNames();
    const added: FakeTool = { ...READ_TOOL, name: 'added_later' };
    server.tools.push(added);
    server.handlers.set('added_later', () => textResult({ ok: 'new' }, 1));
    const res = await call('added_later');
    expect(res.code, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ ok: 'new' });
  });

  it('a tool removed on the server fails as unknown_tool, and that failed call already refreshed the cache', async () => {
    expect(await toolNames()).toContain('company_lookup');
    server.tools = server.tools.filter((t) => t.name !== 'company_lookup');
    const res = await call('company_lookup');
    expect(res.code).toBe(2);
    expect(errorBody(res).error.details?.reason).toBe('unknown_tool');
    const listed = JSON.parse((await runCli(['tools', 'list', '--json'], sb.env)).stdout) as { from_cache: boolean; tools: Array<{ name: string }> };
    expect(listed.from_cache).toBe(true);
    expect(listed.tools.map((t) => t.name)).not.toContain('company_lookup');
  });

  it('`tools list` before any call can be stale; --refresh bypasses the cache', async () => {
    await toolNames();
    server.tools = server.tools.filter((t) => t.name !== 'company_lookup');
    expect(await toolNames()).toContain('company_lookup');
    expect(await toolNames(['--refresh'])).not.toContain('company_lookup');
  });

  it('a tool whose schema gained an optional field keeps working with old inputs', async () => {
    await toolNames();
    server.tools = server.tools.map((t) =>
      t.name === 'company_lookup'
        ? { ...t, inputSchema: { ...t.inputSchema, properties: { ...(t.inputSchema.properties as object), industry: { type: 'string' } } } }
        : t,
    );
    const res = await call('company_lookup');
    expect(res.code, res.stderr).toBe(0);
  });

  it('a tool that stops advertising readOnlyHint is treated as `run`, never silently as a lookup', async () => {
    await toolNames();
    server.tools = server.tools.map((t) => (t.name === 'company_lookup' ? { ...t, annotations: undefined } : t));
    const asCall = await call('company_lookup');
    expect(asCall.code).toBe(10);
    expect(server.toolCalls()).toHaveLength(0);
    const asRun = await runCli(['run', 'company_lookup', '--input', '{"domain":"acme.com"}'], sb.env);
    expect(asRun.code, asRun.stderr).toBe(0);
  });

  it('a result without _meta.creditCost succeeds and reports the cost as unknown', async () => {
    server.handlers.set('company_lookup', () => textResult({ name: 'Acme' }, null));
    const res = await call('company_lookup');
    expect(res.code, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ name: 'Acme' });
    expect(res.stderr).toMatch(/credit_cost/);
    expect(res.stderr).toMatch(/unknown|null/);
  });

  it('a server that picks a protocol version outside the supported list fails with a named, non-crash error', async () => {
    server.forcedProtocolVersion = '1999-01-01';
    const res = await runCli(['tools', 'list', '--json', '--refresh'], sb.env);
    expect(res.code).toBe(7);
    const err = errorBody(res).error;
    expect(err.code).toBe('server_unreachable');
    expect(err.details?.reason).toBe('unsupported_protocol_version');
    expect(err.message).toContain('1999-01-01');
    expect(err.hint).toMatch(/Upgrade hgi/);
    expect(res.stderr).not.toMatch(/\n\s+at /);
  });
});

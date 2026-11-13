import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { credentialsFile, makeSandbox, readCreds, runCli, type CliResult, type Sandbox } from '../support/cli.js';
import { errorBody, login, seedServer } from '../support/e2e.js';
import { FakeServer, textResult } from '../support/fake-server.js';

const server = new FakeServer();
let sb: Sandbox;

const LOCAL_ONLY = "Local to this machine: calls made by hgi here, not your organization's bill.";
const KEYS = ['v', 'ts', 'host', 'verb', 'tool', 'label', 'credit_cost', 'budget_id', 'mcp_version', 'status'];

beforeAll(() => server.start());
afterAll(() => server.stop());
beforeEach(async () => {
  seedServer(server);
  server.mcpVersion = 'v2';
  sb = makeSandbox(server.base);
  await login(sb);
});
afterEach(() => sb.cleanup());

const ledgerFile = () => path.join(sb.configDir, 'ledger.jsonl');
const host = () => new URL(server.base).host;
const lookup = (extra: string[] = [], env: NodeJS.ProcessEnv = sb.env) =>
  runCli(['call', 'company_lookup', '--input', '{"domain":"acme.com"}', ...extra], env);
const startAgent = (extra: string[] = [], env: NodeJS.ProcessEnv = sb.env) =>
  runCli(['run', 'start_agent', '--input', '{"agent":"a"}', ...extra], env);
const usage = (args: string[] = [], env: NodeJS.ProcessEnv = sb.env) => runCli(['usage', ...args], env);

function ledgerLines(file = ledgerFile()): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l !== '');
}

function seed(rows: Array<Partial<Record<string, unknown>>>, file = ledgerFile()): void {
  const lines = rows.map((r) =>
    JSON.stringify({
      v: 1,
      ts: new Date().toISOString(),
      host: host(),
      verb: 'call',
      tool: 'company_lookup',
      label: null,
      credit_cost: 1,
      budget_id: null,
      mcp_version: 'v2',
      status: 'ok',
      ...r,
    }),
  );
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
}

function ok(res: CliResult): CliResult {
  expect(res.code, res.stderr).toBe(0);
  return res;
}

function json<T = Array<Record<string, unknown>>>(res: CliResult): T {
  return JSON.parse(ok(res).stdout) as T;
}

function ledgerWarnings(res: CliResult): unknown[] {
  return res.stderr
    .split('\n')
    .filter((l) => l.includes('ledger_not_updated'))
    .map((l) => JSON.parse(l) as unknown);
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? [p, ...walk(p)] : [p];
  });
}

function expectError(res: CliResult, exit: number, code: string) {
  expect(res.code, res.stderr).toBe(exit);
  const { error } = errorBody(res);
  expect(error.code).toBe(code);
  expect(res.stdout).toBe('');
  return error;
}

describe('Story 1: what this machine spent, by tool', () => {
  it('sums calls by tool, credits desc, and needs no credentials', async () => {
    ok(await lookup());
    ok(await lookup());
    ok(await startAgent());
    const expected = [
      { tool: 'start_agent', calls: 1, credits: 5, zero_cost_calls: 0, unknown_cost_calls: 0 },
      { tool: 'company_lookup', calls: 2, credits: 4, zero_cost_calls: 0, unknown_cost_calls: 0 },
    ];
    expect(json(await usage(['-f', 'json']))).toEqual(expected);
    fs.rmSync(credentialsFile(sb));
    const requestsBefore = server.requests.length;
    expect(json(await usage(['-f', 'json']))).toEqual(expected);
    expect(server.requests.length).toBe(requestsBefore);
  });

  it('each successful call appends exactly one v1 line with no input or result values', async () => {
    ok(await lookup());
    const lines = ledgerLines();
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(Object.keys(row)).toEqual(KEYS);
    expect(row).toMatchObject({ v: 1, host: host(), verb: 'call', tool: 'company_lookup', label: null, credit_cost: 2, budget_id: null, mcp_version: 'v2', status: 'ok' });
    expect(row.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    for (const leaked of ['acme.com', 'Acme', 'domain', 'employees', 'test@example.com', 'example-org']) {
      expect(lines[0]).not.toContain(leaked);
    }
  });

  it('--since takes dates, today, and durations; anything else is bad_since', async () => {
    const env = { ...sb.env, TZ: 'UTC' };
    const now = Date.now();
    const d = new Date(now);
    const todayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const points: Record<string, number> = {
      oct31: Date.UTC(2026, 9, 31, 12),
      nov02: Date.UTC(2026, 10, 2, 12),
      ago10d: now - 10 * 86_400_000,
      ago3d: now - 3 * 86_400_000,
      ago30h: now - 30 * 3_600_000,
      ago1h: now - 3_600_000,
      beforeMidnight: todayStart - 1,
      afterMidnight: Math.min(todayStart + 1, now),
    };
    seed(Object.entries(points).map(([tool, t]) => ({ tool, ts: new Date(t).toISOString() })));
    const expectSince = async (since: string, cutoff: number) => {
      const rows = json(await usage(['--since', since, '--by', 'call', '-f', 'json'], env));
      const want = Object.entries(points)
        .filter(([, t]) => t >= cutoff)
        .sort((a, b) => a[1] - b[1])
        .map(([tool]) => tool);
      expect(rows.map((r) => r.tool)).toEqual(want);
    };
    await expectSince('2026-11-01', Date.UTC(2026, 10, 1));
    await expectSince('today', todayStart);
    await expectSince('24h', now - 24 * 3_600_000);
    await expectSince('7d', now - 7 * 86_400_000);
    const err = expectError(await usage(['--since', 'yesterdayish'], env), 2, 'invalid_input');
    expect(err.details?.reason).toBe('bad_since');
  });

  it('rows recorded against one base URL do not show under another', async () => {
    ok(await lookup());
    expect(json(await usage(['-f', 'json']))).toHaveLength(1);
    expect(json(await usage(['-f', 'json'], { ...sb.env, HGI_BASE_URL: 'http://127.0.0.1:1' }))).toEqual([]);
  });
});

describe('Story 2: cost per pipeline stage and per day', () => {
  it('--label groups by stage; unlabeled calls are label null, shown as (none) in a table', async () => {
    ok(await lookup(['--label', 'resolve']));
    ok(await lookup(['--label', 'resolve']));
    ok(await startAgent(['--label', 'enrich']));
    ok(await lookup());
    expect(json(await usage(['--by', 'label', '-f', 'json']))).toEqual([
      { label: 'enrich', calls: 1, credits: 5, zero_cost_calls: 0, unknown_cost_calls: 0 },
      { label: 'resolve', calls: 2, credits: 4, zero_cost_calls: 0, unknown_cost_calls: 0 },
      { label: null, calls: 1, credits: 2, zero_cost_calls: 0, unknown_cost_calls: 0 },
    ]);
    const table = ok(await usage(['--by', 'label', '-f', 'table']));
    expect(table.stdout).toMatch(/^\(none\)\s+1\s+2\s/m);
  });

  it.each([['has space'], [''], ['a'.repeat(65)]])('--label %j is bad_label: nothing sent, nothing logged', async (label) => {
    const err = expectError(await lookup(['--label', label]), 2, 'invalid_input');
    expect(err.details?.reason).toBe('bad_label');
    expect(server.toolCalls()).toHaveLength(0);
    expect(fs.existsSync(ledgerFile())).toBe(false);
  });

  it('--by day groups by the local date, ascending', async () => {
    seed([
      { ts: '2026-11-01T16:00:00.000Z', credit_cost: 3 },
      { ts: '2026-11-01T14:00:00.000Z', credit_cost: 2 },
    ]);
    const env = { ...sb.env, TZ: 'Asia/Tokyo' };
    expect(json(await usage(['--by', 'day', '-f', 'json'], env))).toEqual([
      { day: '2026-11-01', calls: 1, credits: 2, zero_cost_calls: 0, unknown_cost_calls: 0 },
      { day: '2026-11-02', calls: 1, credits: 3, zero_cost_calls: 0, unknown_cost_calls: 0 },
    ]);
  });
});

describe('Story 3: the raw ledger', () => {
  beforeEach(() => {
    seed([
      { ts: '2026-11-03T00:00:00.000Z', tool: 'second', label: 'enrich' },
      { ts: '2026-11-01T00:00:00.000Z', tool: 'other_host', host: 'staging.example.com' },
      { ts: '2026-11-02T00:00:00.000Z', tool: 'first', credit_cost: null },
    ]);
  });

  it('--by call -f csv is a header plus one row per ledger line for this host, oldest first', async () => {
    const lines = ok(await usage(['--by', 'call', '-f', 'csv'])).stdout.trimEnd().split(/\r?\n/);
    expect(lines[0]).toBe(KEYS.join(','));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(',first,');
    expect(lines[2]).toContain(',second,enrich,');
  });

  it('--by call -f jsonl is one record per line with the ledger keys', async () => {
    const rows = ok(await usage(['--by', 'call', '-f', 'jsonl'])).stdout.trimEnd().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows.map((r) => r.tool)).toEqual(['first', 'second']);
    for (const r of rows) expect(Object.keys(r)).toEqual(KEYS);
  });

  it('an unknown --by is bad_by', async () => {
    const err = expectError(await usage(['--by', 'week']), 2, 'invalid_input');
    expect(err.details?.reason).toBe('bad_by');
  });

  it('works in every format; --select and --out behave as for tools list', async () => {
    for (const format of ['json', 'jsonl', 'csv', 'yaml', 'table']) {
      const res = ok(await usage(['-f', format]));
      expect(res.stderr).toContain(LOCAL_ONLY);
      if (format === 'json') expect(JSON.parse(res.stdout)).toHaveLength(2);
      if (format === 'jsonl') expect(res.stdout.trimEnd().split('\n').map((l) => JSON.parse(l) as unknown)).toHaveLength(2);
      if (format === 'yaml') expect(YAML.parse(res.stdout)).toHaveLength(2);
      if (format === 'csv') expect(res.stdout.trimEnd().split(/\r?\n/)[0]).toBe('tool,calls,credits,zero_cost_calls,unknown_cost_calls');
      if (format === 'table') expect(res.stdout).toMatch(/^tool\s+calls\s+credits/);
    }
    expect(json(await usage(['-f', 'json', '--select', 'tool,credits']))).toEqual([
      { tool: 'second', credits: 1 },
      { tool: 'first', credits: 0 },
    ]);
    const out = path.join(sb.dir, 'usage.json');
    const written = ok(await usage(['-f', 'json', '--out', out]));
    expect(written.stdout).toBe('');
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toHaveLength(2);
    const again = expectError(await usage(['-f', 'json', '--out', out]), 2, 'invalid_input');
    expect(again.details?.reason).toBe('out_exists');
  });
});

describe('Story 4: parallel runs and ledger trouble', () => {
  it('20 concurrent calls leave exactly 20 well-formed lines', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => lookup()));
    for (const r of results) {
      expect(r.code, r.stderr).toBe(0);
      expect(ledgerWarnings(r)).toEqual([]);
    }
    const lines = ledgerLines();
    expect(lines).toHaveLength(20);
    for (const l of lines) expect(Object.keys(JSON.parse(l) as object)).toEqual(KEYS);
    expect(json(await usage(['-f', 'json']))[0]).toMatchObject({ tool: 'company_lookup', calls: 20, credits: 40 });
  }, 90_000);

  it('isError and credit_limit_exceeded keep their exit codes and log status tool_error', async () => {
    server.handlers.set('company_lookup', () => ({ isError: true, content: [{ type: 'text', text: 'boom' }], _meta: { creditCost: 1 } }));
    expect((await lookup()).code).toBe(3);
    server.handlers.set('company_lookup', () => ({ isError: true, content: [{ type: 'text', text: 'no credits' }], _meta: { errorCode: 'credit_limit_exceeded' } }));
    expect((await lookup()).code).toBe(6);
    const rows = ledgerLines().map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows.map((r) => [r.status, r.credit_cost])).toEqual([
      ['tool_error', 1],
      ['tool_error', null],
    ]);
  });

  it('a call that is never sent is never logged (wrong verb, unknown tool, schema-invalid input)', async () => {
    expect((await runCli(['call', 'start_agent', '--input', '{"agent":"a"}'], sb.env)).code).toBe(10);
    expect((await runCli(['call', 'no_such_tool'], sb.env)).code).toBe(2);
    expect((await runCli(['call', 'company_lookup', '--input', '{}'], sb.env)).code).toBe(2);
    expect(server.toolCalls()).toHaveLength(0);
    expect(fs.existsSync(ledgerFile())).toBe(false);
  });

  it('a symlink at the ledger path: the call succeeds, one warning, the target is untouched', async () => {
    const target = path.join(sb.dir, 'target.txt');
    fs.writeFileSync(target, 'keep');
    fs.symlinkSync(target, ledgerFile());
    const res = ok(await lookup());
    expect(JSON.parse(res.stdout)).toEqual({ domain: 'acme.com', name: 'Acme', employees: 120 });
    expect(ledgerWarnings(res)).toEqual([{ warning: 'ledger_not_updated', reason: 'symlink' }]);
    expect(fs.readFileSync(target, 'utf8')).toBe('keep');
  });

  it('a lock held past the retry budget: the call succeeds with one warning', async () => {
    fs.mkdirSync(`${ledgerFile()}.lock`);
    const res = ok(await lookup());
    expect(JSON.parse(res.stdout)).toMatchObject({ name: 'Acme' });
    expect(ledgerWarnings(res)).toEqual([{ warning: 'ledger_not_updated', reason: 'lock_timeout' }]);
    expect(res.stderr).toContain('"credit_cost":2');
  }, 30_000);

  it('an --out failure after the call (exit 12, tool_ran) still leaves the line', async () => {
    const out = path.join(sb.dir, 'raced.json');
    server.handlers.set('start_agent', () => {
      fs.writeFileSync(out, 'appeared during the call');
      return textResult({ run_id: 'r-raced' }, 5);
    });
    const res = await startAgent(['--out', out]);
    expect(res.code).toBe(12);
    expect(errorBody(res).error.details).toMatchObject({ tool_ran: true });
    expect(ledgerLines().map((l) => (JSON.parse(l) as Record<string, unknown>).credit_cost)).toEqual([5]);
  });

  it('a new ledger is 0600 in a 0700 directory', async () => {
    const file = path.join(sb.dir, 'ledgers', 'nested', 'ledger.jsonl');
    ok(await lookup([], { ...sb.env, HGI_LEDGER: file }));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });

  it('HGI_LEDGER inside a git working tree (directly or via a symlink) is refused before sending', async () => {
    const repo = path.join(sb.dir, 'repo');
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    fs.symlinkSync(path.join(sb.dir, 'elsewhere.jsonl'), path.join(repo, 'link.jsonl'));
    for (const file of [path.join(repo, 'ledger.jsonl'), path.join(repo, 'link.jsonl')]) {
      const res = await runCli(['call', 'company_lookup', '--input', '{"domain":"acme.com"}'], { ...sb.env, HGI_LEDGER: file }, { cwd: repo });
      expect(expectError(res, 2, 'invalid_input').details?.reason).toBe('workspace_guard');
    }
    expect(server.toolCalls()).toHaveLength(0);
    expect(fs.existsSync(path.join(sb.dir, 'elsewhere.jsonl'))).toBe(false);
  });

  it('HGI_BUDGET_ID is recorded when set, null otherwise', async () => {
    ok(await lookup([], { ...sb.env, HGI_BUDGET_ID: 'run-42' }));
    ok(await lookup([], { ...sb.env, HGI_BUDGET_ID: '' }));
    expect(ledgerLines().map((l) => (JSON.parse(l) as Record<string, unknown>).budget_id)).toEqual(['run-42', null]);
  });

  it('a hostile X-MCP-Version header never puts a token in the ledger or the usage output', async () => {
    const token = readCreds(sb).access_token;
    server.mcpVersion = token;
    ok(await lookup());
    expect(fs.readFileSync(ledgerFile(), 'utf8')).not.toContain(token);
    expect(JSON.parse(ledgerLines()[0] as string)).toMatchObject({ mcp_version: null });
    const res = ok(await usage(['--by', 'call', '-f', 'json']));
    expect(res.stdout + res.stderr).not.toContain(token);
  });
});

describe('Story 5: honest numbers', () => {
  it('cost 0 and unreported cost are told apart, in JSON and in the table', async () => {
    server.handlers.set('company_lookup', () => textResult({ cached: true }, 0));
    ok(await lookup());
    ok(await runCli(['run', 'aggregated_thing'], sb.env));
    expect(ledgerLines().map((l) => (JSON.parse(l) as Record<string, unknown>).credit_cost)).toEqual([0, null]);
    const rows = json(await usage(['-f', 'json']));
    expect(rows).toEqual([
      { tool: 'aggregated_thing', calls: 1, credits: 0, zero_cost_calls: 0, unknown_cost_calls: 1 },
      { tool: 'company_lookup', calls: 1, credits: 0, zero_cost_calls: 1, unknown_cost_calls: 0 },
    ]);
    const table = ok(await usage(['-f', 'table']));
    expect(table.stdout).toMatch(/^company_lookup\s+1\s+0 \(server cache or free tool\)\s/m);
    // A 0 that only comes from unknown-cost calls is not labeled as a cache hit or free tool.
    expect(table.stdout).toMatch(/^aggregated_thing\s+1\s+0\s+0\s+1$/m);
    expect(table.stderr).toContain('zero_cost_calls:');
    expect(table.stderr).toContain('unknown_cost_calls:');
  });

  it('prints the local-only notice on stderr in every format, with clean stdout', async () => {
    ok(await lookup());
    for (const format of ['json', 'jsonl', 'csv', 'yaml', 'table']) {
      const res = ok(await usage(['-f', format]));
      expect(res.stderr.split('\n')).toContain(LOCAL_ONLY);
      expect(res.stdout).not.toContain('Local to this machine');
    }
  });

  it('no ledger: [] and a note; a torn last line is skipped with a warning', async () => {
    const empty = ok(await usage(['-f', 'json']));
    expect(JSON.parse(empty.stdout)).toEqual([]);
    expect(empty.stderr).toContain('nothing has been recorded on this machine yet');
    ok(await lookup());
    ok(await lookup());
    const text = fs.readFileSync(ledgerFile(), 'utf8');
    fs.writeFileSync(ledgerFile(), text.slice(0, text.length - 30));
    const torn = ok(await usage(['-f', 'json']));
    expect(JSON.parse(torn.stdout)).toEqual([{ tool: 'company_lookup', calls: 1, credits: 2, zero_cost_calls: 0, unknown_cost_calls: 0 }]);
    expect(torn.stderr).toContain('skipped 1 malformed ledger line');
  });

  it('an unsafe or unreadable ledger is exit 12, not a misleading []', async () => {
    const target = path.join(sb.dir, 'target.jsonl');
    fs.writeFileSync(target, '');
    fs.symlinkSync(target, ledgerFile());
    expect(expectError(await usage(['-f', 'json']), 12, 'local_state_error').details).toMatchObject({ kind: 'ledger_unsafe', reason: 'symlink' });
    fs.rmSync(ledgerFile());
    if (process.getuid?.() === 0) return;
    seed([{}]);
    fs.chmodSync(ledgerFile(), 0o000);
    expect(expectError(await usage(['-f', 'json']), 12, 'local_state_error').details).toMatchObject({ kind: 'read_failed', reason: 'EACCES' });
  });
});

describe('Story 6: turning it off', () => {
  it('HGI_LEDGER=off writes and locks nothing, and hgi usage says so', async () => {
    const env = { ...sb.env, HGI_LEDGER: 'off' };
    ok(await lookup([], env));
    expect(walk(sb.dir).filter((p) => path.basename(p).includes('ledger'))).toEqual([]);
    const res = ok(await usage(['-f', 'json'], env));
    expect(JSON.parse(res.stdout)).toEqual([]);
    expect(res.stderr).toContain('disabled');
  });
});

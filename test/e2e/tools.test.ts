import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hgiShellCommand, makeSandbox, runCli, type Sandbox } from '../support/cli.js';
import { errorBody, login, seedServer } from '../support/e2e.js';
import { FakeServer, READ_TOOL, WRITE_TOOL, textResult, type FakeTool } from '../support/fake-server.js';

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

const lookup = (args: string[] = []) => runCli(['call', 'company_lookup', '--input', '{"domain":"acme.com"}', ...args], sb.env);

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

describe('Story 2: the agent learns what it can call', () => {
  it('tools list --json matches the server tools/list, marks call/run and shows the MCP version', async () => {
    const res = await runCli(['tools', 'list', '--json'], sb.env);
    expect(res.code, res.stderr).toBe(0);
    const body = JSON.parse(res.stdout) as {
      mcp_version: string;
      count: number;
      tools: Array<{ name: string; verb: string; read_only: boolean | null; required: string[]; input_schema: unknown }>;
    };
    expect(body.mcp_version).toBe('v2');
    expect(body.tools.map((t) => t.name)).toEqual(server.tools.map((t) => t.name));
    expect(body.tools.map((t) => t.input_schema)).toEqual(server.tools.map((t) => t.inputSchema));
    expect(Object.fromEntries(body.tools.map((t) => [t.name, t.verb]))).toEqual({
      company_lookup: 'call',
      start_agent: 'run',
      aggregated_thing: 'run',
    });
    expect(body.tools[0]?.required).toEqual(['domain']);
    expect(body.tools[2]?.read_only).toBeNull();
  });

  it('serves the cache, and --refresh shows server-side changes; a removed tool fails with unknown_tool (exit 2)', async () => {
    const first = JSON.parse((await runCli(['tools', 'list', '--json'], sb.env)).stdout) as { from_cache: boolean };
    expect(first.from_cache).toBe(false);
    server.tools = server.tools.slice(1);
    const cached = JSON.parse((await runCli(['tools', 'list', '--json'], sb.env)).stdout) as { from_cache: boolean; count: number };
    expect(cached.from_cache).toBe(true);
    expect(cached.count).toBe(3);
    const refreshed = JSON.parse((await runCli(['tools', 'list', '--json', '--refresh'], sb.env)).stdout) as {
      count: number;
      tools: Array<{ name: string }>;
    };
    expect(refreshed.count).toBe(2);
    expect(refreshed.tools.map((t) => t.name)).not.toContain('company_lookup');

    const gone = await lookup();
    expect(gone.code).toBe(2);
    const err = errorBody(gone).error;
    expect(err.code).toBe('invalid_input');
    expect(err.details?.reason).toBe('unknown_tool');
    expect(server.toolCalls()).toHaveLength(0);
  });

  it('a newly added tool is callable immediately even with a stale cache', async () => {
    await runCli(['tools', 'list', '--json'], sb.env);
    const added: FakeTool = { ...READ_TOOL, name: 'brand_new' };
    server.tools.push(added);
    server.handlers.set('brand_new', () => textResult({ hello: 'world' }, 1));
    const res = await runCli(['call', 'brand_new', '--input', '{"domain":"x.com"}'], sb.env);
    expect(res.code, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ hello: 'world' });
  });

  it('table format lists name, verb and required fields', async () => {
    const res = await runCli(['tools', 'list', '-f', 'table'], sb.env);
    expect(res.stdout).toMatch(/name\s+verb\s+required\s+description/);
    expect(res.stdout).toMatch(/company_lookup\s+call\s+domain/);
    expect(res.stderr).toContain('mcp_version: v2');
  });
});

describe('Story 3: lookups', () => {
  it('prints valid JSON, exit 0, and reports the credit cost on stderr', async () => {
    const res = await lookup();
    expect(res.code, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ domain: 'acme.com', name: 'Acme', employees: 120 });
    expect(JSON.parse(res.stderr.trim().split('\n').pop() as string)).toEqual({ credit_cost: 2 });
  });
  it('--select keeps only the chosen fields', async () => {
    const res = await lookup(['--select', 'name,employees']);
    expect(JSON.parse(res.stdout)).toEqual({ name: 'Acme', employees: 120 });
  });
  it('--meta wraps result, credit_cost and mcp_version; a tool with no cost reports null', async () => {
    const meta = JSON.parse((await lookup(['--meta'])).stdout) as Record<string, unknown>;
    expect(meta).toEqual({ result: { domain: 'acme.com', name: 'Acme', employees: 120 }, credit_cost: 2, mcp_version: 'v2' });
    const agg = await runCli(['run', 'aggregated_thing', '--meta'], sb.env);
    expect(JSON.parse(agg.stdout)).toMatchObject({ credit_cost: null });
    expect(agg.stderr).toContain('"credit_cost":null');
  });
  it('--select applies to the result inside the --meta envelope', async () => {
    const res = await lookup(['--meta', '--select', 'name']);
    expect(JSON.parse(res.stdout)).toEqual({ result: { name: 'Acme' }, credit_cost: 2, mcp_version: 'v2' });
  });
  it('--no-validate lets the server judge input the client schema would refuse', async () => {
    server.handlers.set('company_lookup', () => ({ isError: true, content: [{ type: 'text', text: 'server says no' }] }));
    const res = await runCli(['call', 'company_lookup', '--input', '{"limit":"ten"}', '--no-validate'], sb.env);
    expect(res.code).toBe(3);
    expect(server.toolCalls()).toHaveLength(1);
  });
  it('accepts input from stdin and from @file', async () => {
    const viaStdin = await runCli(['call', 'company_lookup', '--input', '-'], sb.env, { input: '{"domain":"stdin.com"}' });
    expect(JSON.parse(viaStdin.stdout).domain).toBe('stdin.com');
    const file = path.join(sb.dir, 'in.json');
    fs.writeFileSync(file, '{"domain":"file.com"}');
    const viaFile = await runCli(['call', 'company_lookup', '--input', `@${file}`], sb.env);
    expect(JSON.parse(viaFile.stdout).domain).toBe('file.com');
  });
  it('a tool whose outputSchema the result does not satisfy still succeeds (no SDK output validation)', async () => {
    server.tools.push({
      ...READ_TOOL,
      name: 'schema_drift',
      outputSchema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
    });
    server.handlers.set('schema_drift', () => textResult({ y: 'not x' }, 1));
    const res = await runCli(['call', 'schema_drift', '--input', '{"domain":"a.com"}'], sb.env);
    expect(res.code, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ y: 'not x' });
  });
  it('structuredContent wins over a summary text block', async () => {
    server.handlers.set('company_lookup', () => ({
      content: [{ type: 'text', text: 'Found 2 artifact(s).' }],
      structuredContent: { artifacts: [{ id: 1 }, { id: 2 }] },
      _meta: { creditCost: 1 },
    }));
    expect(JSON.parse((await lookup()).stdout)).toEqual({ artifacts: [{ id: 1 }, { id: 2 }] });
  });
});

describe('Story 4: state-changing actions are a separate verb', () => {
  it('run works on a state-changing tool', async () => {
    const res = await runCli(['run', 'start_agent', '--input', '{"agent":"a1"}'], sb.env);
    expect(res.code, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ run_id: 'r1' });
    expect(server.toolCalls()).toHaveLength(1);
  });
  it('call on a state-changing tool exits 10, names `hgi run`, and sends no tools/call', async () => {
    const res = await runCli(['call', 'start_agent', '--input', '{"agent":"a1"}'], sb.env);
    expect(res.code).toBe(10);
    const err = errorBody(res).error;
    expect(err.code).toBe('wrong_verb');
    expect(err.message + (err.hint ?? '')).toContain('hgi run start_agent');
    expect(err.details).toMatchObject({ expected_verb: 'run' });
    expect(server.toolCalls()).toHaveLength(0);
  });
  it('run on a read-only tool exits 10, names `hgi call`, and sends no tools/call', async () => {
    const res = await runCli(['run', 'company_lookup', '--input', '{"domain":"a.com"}'], sb.env);
    expect(res.code).toBe(10);
    expect(errorBody(res).error.message).toContain('hgi call');
    expect(server.toolCalls()).toHaveLength(0);
  });
  it('a tool with missing annotations is treated as state-changing', async () => {
    const asCall = await runCli(['call', 'aggregated_thing'], sb.env);
    expect(asCall.code).toBe(10);
    expect(server.toolCalls()).toHaveLength(0);
    const asRun = await runCli(['run', 'aggregated_thing'], sb.env);
    expect(asRun.code, asRun.stderr).toBe(0);
  });
  it('the verb decision uses a fresh tools/list, not a stale cache that says read-only', async () => {
    await runCli(['tools', 'list', '--json'], sb.env);
    server.tools = [{ ...READ_TOOL, annotations: { readOnlyHint: false } }, WRITE_TOOL];
    const res = await lookup();
    expect(res.code).toBe(10);
    expect(server.toolCalls()).toHaveLength(0);
  });
});

describe('Story 6: formats and large results', () => {
  const rows = Array.from({ length: 6000 }, (_, i) => ({
    id: i,
    name: `Company ${i}, "quoted"`,
    domain: `c${i}.example.com`,
    tags: ['a', 'b'],
    note: 'x'.repeat(200),
  }));

  beforeEach(() => {
    server.handlers.set('company_lookup', () => textResult({ total: rows.length, companies: rows }, 3));
  });

  it('defaults to JSON when piped and returns every row', async () => {
    const res = await lookup();
    expect(res.code, res.stderr).toBe(0);
    const body = JSON.parse(res.stdout) as { companies: typeof rows };
    expect(body.companies).toHaveLength(6000);
    expect(body.companies[5999]).toEqual(rows[5999]);
    expect(res.stdout.length).toBeGreaterThan(1_500_000);
  });
  it('jsonl: one parseable line per row, complete', async () => {
    const res = await lookup(['-f', 'jsonl']);
    const lines = res.stdout.trim().split('\n');
    expect(lines).toHaveLength(6000);
    expect(JSON.parse(lines[5999] as string)).toEqual(rows[5999]);
  });
  it('csv: a CSV reader recovers every row and cell, including quotes and nested values', async () => {
    const res = await lookup(['-f', 'csv']);
    const parsed = parseCsv(res.stdout);
    expect(parsed[0]).toEqual(['id', 'name', 'domain', 'tags', 'note']);
    expect(parsed).toHaveLength(6001);
    expect(parsed[6000]).toEqual(['5999', 'Company 5999, "quoted"', 'c5999.example.com', '["a","b"]', 'x'.repeat(200)]);
  });
  it('yaml: parses back to the same data', async () => {
    const res = await lookup(['-f', 'yaml']);
    const body = YAML.parse(res.stdout) as { total: number; companies: typeof rows };
    expect(body.companies).toEqual(rows);
  });
  it('table: prints all rows untruncated', async () => {
    const res = await lookup(['-f', 'table']);
    const lines = res.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(6002);
    expect(lines[6001]).toContain('x'.repeat(200));
  });
  it('--out writes the complete result to a new file and refuses to overwrite it', async () => {
    const out = path.join(sb.dir, 'result.json');
    const first = await lookup(['--out', out]);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toBe('');
    expect((JSON.parse(fs.readFileSync(out, 'utf8')) as { companies: unknown[] }).companies).toHaveLength(6000);
    const again = await lookup(['--out', out]);
    expect(again.code).toBe(2);
    expect(errorBody(again).error.details?.reason).toBe('out_exists');
  });
  it('rejects an unknown format with exit 2', async () => {
    const res = await lookup(['-f', 'xml']);
    expect(res.code).toBe(2);
  });
  it('a reader that closes early (| head) does not make hgi fail noisily, and hgi itself exits 0', async () => {
    const errFile = path.join(sb.dir, 'epipe.err');
    const res = await new Promise<{ code: number | null }>((resolve) => {
      const script = `set -o pipefail; ${hgiShellCommand()} call company_lookup --input '{"domain":"a.com"}' 2>${errFile} | head -c 100 > /dev/null`;
      const child = spawn('bash', ['-c', script], { env: sb.env });
      child.on('close', (code) => resolve({ code }));
    });
    expect(res.code).toBe(0);
    expect(fs.readFileSync(errFile, 'utf8')).not.toContain('EPIPE');
  });
});

describe('--out / --input guards keep `hgi call *` to lookups', () => {
  it('--force is refused on call but allowed on run for an existing regular file', async () => {
    const out = path.join(sb.dir, 'existing.json');
    fs.writeFileSync(out, 'old');
    const call = await lookup(['--out', out, '--force']);
    expect(call.code).toBe(2);
    expect(errorBody(call).error.details?.reason).toBe('force_on_call');
    expect(fs.readFileSync(out, 'utf8')).toBe('old');
    expect(server.toolCalls()).toHaveLength(0);
    const run = await runCli(['run', 'start_agent', '--input', '{"agent":"a"}', '--out', out, '--force'], sb.env);
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual({ run_id: 'r1' });
  });
  it('refuses to write through a symlink or into hgi config/cache dirs', async () => {
    const target = path.join(sb.dir, 'target.txt');
    fs.writeFileSync(target, 'precious');
    const link = path.join(sb.dir, 'link.json');
    fs.symlinkSync(target, link);
    const viaLink = await runCli(['run', 'start_agent', '--input', '{"agent":"a"}', '--out', link, '--force'], sb.env);
    expect(viaLink.code).toBe(2);
    expect(fs.readFileSync(target, 'utf8')).toBe('precious');
    expect(server.toolCalls()).toHaveLength(0);
    const creds = fs.readdirSync(sb.configDir).find((f) => f.startsWith('credentials-')) as string;
    const intoConfig = await runCli(
      ['run', 'start_agent', '--input', '{"agent":"a"}', '--out', path.join(sb.configDir, creds), '--force'],
      sb.env,
    );
    expect(intoConfig.code).toBe(2);
    expect(errorBody(intoConfig).error.details?.reason).toBe('protected_path');
    expect(JSON.parse(fs.readFileSync(path.join(sb.configDir, creds), 'utf8')).access_token).toMatch(/^at_/);
    expect(server.toolCalls()).toHaveLength(0);
  });
  it('checks every output option BEFORE the tool runs (nothing is billed for a refused --out, -f or --select)', async () => {
    const out = path.join(sb.dir, 'taken.json');
    fs.writeFileSync(out, 'x');
    for (const args of [
      ['call', 'company_lookup', '--input', '{"domain":"a.com"}', '--out', out],
      ['run', 'start_agent', '--input', '{"agent":"a"}', '--out', out],
      ['call', 'company_lookup', '--input', '{"domain":"a.com"}', '-f', 'xml'],
      ['call', 'company_lookup', '--input', '{"domain":"a.com"}', '--select', ' , '],
      ['tools', 'list', '-f', 'xml'],
      ['call', 'company_lookup', '--input', '{"domain":"a.com"}', '--out', path.join(sb.dir, 'no-such-dir', 'x.json')],
      ['run', 'start_agent', '--input', '{"agent":"a"}', '--out', path.join(sb.dir, 'no-such-dir', 'x.json')],
    ]) {
      const res = await runCli(args, sb.env);
      expect(res.code, args.join(' ')).toBe(2);
    }
    expect(server.toolCalls()).toHaveLength(0);
  });
  it('an unwritable --out directory is refused before the tool runs', async () => {
    const locked = path.join(sb.dir, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o500);
    try {
      if (process.getuid?.() === 0) return;
      const res = await runCli(['run', 'start_agent', '--input', '{"agent":"a"}', '--out', path.join(locked, 'x.json')], sb.env);
      expect(res.code).toBe(2);
      expect(errorBody(res).error.details?.reason).toBe('out_dir_unwritable');
      expect(server.toolCalls()).toHaveLength(0);
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });
  it('if the --out write fails AFTER the tool ran, the result is still printed and the error says not to re-run', async () => {
    const out = path.join(sb.dir, 'raced.json');
    server.handlers.set('start_agent', () => {
      fs.writeFileSync(out, 'appeared during the call');
      return textResult({ run_id: 'r-raced' }, 5);
    });
    const res = await runCli(['run', 'start_agent', '--input', '{"agent":"a"}', '--out', out], sb.env);
    expect(res.code).toBe(12);
    expect(JSON.parse(res.stdout)).toEqual({ run_id: 'r-raced' });
    const err = errorBody(res).error;
    expect(err.code).toBe('local_state_error');
    expect(err.details).toMatchObject({ kind: 'write_failed', reason: 'out_exists', tool_ran: true });
    expect(err.hint).toContain('Do NOT re-run');
    expect(res.stderr).toContain('"credit_cost":5');
    expect(fs.readFileSync(out, 'utf8')).toBe('appeared during the call');
    expect(server.toolCalls()).toHaveLength(1);
  });
  it('the protected-path guard also catches case variants on a case-insensitive filesystem', async () => {
    const upper = sb.configDir.toUpperCase();
    if (!fs.existsSync(upper) || upper === sb.configDir) return;
    const creds = fs.readdirSync(sb.configDir).find((f) => f.startsWith('credentials-')) as string;
    const before = fs.readFileSync(path.join(sb.configDir, creds), 'utf8');
    const overwrite = await runCli(['run', 'start_agent', '--input', '{"agent":"a"}', '--out', path.join(upper, creds), '--force'], sb.env);
    expect(overwrite.code).toBe(2);
    expect(errorBody(overwrite).error.details?.reason).toBe('protected_path');
    const create = await lookup(['--out', path.join(upper, 'planted.json')]);
    expect(create.code).toBe(2);
    expect(fs.existsSync(path.join(sb.configDir, 'planted.json'))).toBe(false);
    expect(fs.readFileSync(path.join(sb.configDir, creds), 'utf8')).toBe(before);
    expect(server.toolCalls()).toHaveLength(0);
  });
  it('refuses --input @file for credentials files, including via a symlink or hard link', async () => {
    const creds = path.join(sb.configDir, fs.readdirSync(sb.configDir).find((f) => f.startsWith('credentials-')) as string);
    const direct = await runCli(['call', 'company_lookup', '--input', `@${creds}`], sb.env);
    expect(direct.code).toBe(2);
    expect(errorBody(direct).error.details?.reason).toBe('protected_path');
    const sym = path.join(sb.dir, 'sym.json');
    fs.symlinkSync(creds, sym);
    const viaSym = await runCli(['call', 'company_lookup', '--input', `@${sym}`], sb.env);
    expect(viaSym.code).toBe(2);
    expect(errorBody(viaSym).error.details?.reason).toBe('protected_path');
    const hard = path.join(sb.dir, 'hard.json');
    fs.linkSync(creds, hard);
    const viaHard = await runCli(['call', 'company_lookup', '--input', `@${hard}`], sb.env);
    expect(viaHard.code).toBe(2);
    expect(errorBody(viaHard).error.details?.reason).toBe('protected_path');
    expect(server.toolCalls()).toHaveLength(0);
  });
});

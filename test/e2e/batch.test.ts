import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeSandbox, readCreds, runCli, runCliInPty, startCli, type CliResult, type Sandbox } from '../support/cli.js';
import { errorBody, login, seedServer } from '../support/e2e.js';
import { FakeServer, textResult, type FakeTool, type ToolResult } from '../support/fake-server.js';

const server = new FakeServer();
let sb: Sandbox;

const BATCH = 'company_batch';

function batchTool(props: Record<string, unknown> = {}, extra: Partial<FakeTool> = {}): FakeTool {
  return {
    name: BATCH,
    description: 'Batch lookup.',
    inputSchema: {
      type: 'object',
      properties: {
        hg_ids: { type: 'array', items: { type: 'string' }, maxItems: 25 },
        category_names: { type: 'array', items: { type: 'string' } },
        ...props,
      },
    },
    annotations: { readOnlyHint: true },
    ...extra,
  };
}

type Args = { hg_ids?: string[]; domains?: string[]; category_names?: string[] };

function echo(args: Args, cost: number | null = 1): ToolResult {
  const companies = [
    ...(args.hg_ids ?? []).map((id) => ({ company_id: id, name: `co-${id}` })),
    ...(args.domains ?? []).map((d) => ({ company_domain: d, name: `co-${d}` })),
  ];
  return textResult({ companies }, cost);
}

function setTool(tool: FakeTool, handler: (args: Args, n: number) => ToolResult | Promise<ToolResult> = (a) => echo(a)): void {
  server.tools = server.tools.filter((t) => t.name !== tool.name).concat(tool);
  let n = 0;
  server.handlers.set(tool.name, (args) => handler(args as Args, (n += 1)));
}

/** n distinct 32-character HG ids. */
function ids(n: number, from = 0): string[] {
  return Array.from({ length: n }, (_, i) => `a${String(i + from).padStart(31, '0')}`);
}

function idsFile(lines: string[] | string, name = 'ids.txt'): string {
  const file = path.join(sb.dir, name);
  fs.writeFileSync(file, Array.isArray(lines) ? `${lines.join('\n')}\n` : lines);
  return file;
}

const call = (args: string[], opts: { input?: string } = {}) => runCli(['call', BATCH, ...args], sb.env, opts);

function sent(): Args[] {
  return server.toolCalls().map((r) => (JSON.parse(r.body ?? '{}') as { params: { arguments: Args } }).params.arguments);
}

function sentBodies(): string[] {
  return server.toolCalls().map((r) => JSON.stringify((JSON.parse(r.body ?? '{}') as { params: unknown }).params));
}

type Row = { input: string; result?: Record<string, unknown>; error?: { code: string; message: string } };

function rows(res: CliResult): Row[] {
  return res.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row);
}

function stderrJsonLines(res: CliResult): Array<Record<string, unknown>> {
  return res.stderr
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function expectRefused(res: CliResult, reason: string): void {
  expect(res.code, res.stderr).toBe(2);
  expect(errorBody(res).error.details?.reason).toBe(reason);
  expect(server.toolCalls()).toHaveLength(0);
}

const creditLimit = (): ToolResult => ({
  isError: true,
  content: [{ type: 'text', text: 'Credit limit reached.' }],
  _meta: { errorCode: 'credit_limit_exceeded' },
});

beforeAll(() => server.start());
afterAll(() => server.stop());
beforeEach(async () => {
  seedServer(server);
  setTool(batchTool());
  sb = makeSandbox(server.base);
  await login(sb);
});
afterEach(() => sb.cleanup());

describe('Story 1: look up a whole list in one command', () => {
  it('60 ids go out as 25, 25 and 10 in first-appearance order; 60 JSONL rows come back in input order', async () => {
    const list = ids(60).reverse();
    const res = await call(['--ids', `@${idsFile(list)}`, '--input', '{"category_names":["CRM"]}']);
    expect(res.code, res.stderr).toBe(0);
    expect(sent().map((a) => a.hg_ids)).toEqual([list.slice(0, 25), list.slice(25, 50), list.slice(50)]);
    expect(sent().every((a) => JSON.stringify(a.category_names) === '["CRM"]')).toBe(true);
    const out = rows(res);
    expect(out.map((r) => r.input)).toEqual(list);
    expect(out[0]).toEqual({ input: list[0], result: { company_id: list[0], name: `co-${list[0]}` } });
  });

  it('batch size follows maxItems, defaults to 25 without it, and --batch-size lowers it', async () => {
    setTool(batchTool({ hg_ids: { type: 'array', items: { type: 'string' }, maxItems: 10 } }));
    expect((await call(['--ids', `@${idsFile(ids(23))}`])).code).toBe(0);
    expect(sent().map((a) => a.hg_ids?.length)).toEqual([10, 10, 3]);

    server.requests = [];
    setTool(batchTool({ hg_ids: { type: 'array', items: { type: 'string' } } }));
    expect((await call(['--ids', `@${idsFile(ids(30))}`])).code).toBe(0);
    expect(sent().map((a) => a.hg_ids?.length)).toEqual([25, 5]);

    server.requests = [];
    expect((await call(['--ids', `@${idsFile(ids(12))}`, '--batch-size', '5'])).code).toBe(0);
    expect(sent().map((a) => a.hg_ids?.length)).toEqual([5, 5, 2]);
  });

  it('the same file sends byte-identical batches every time; a duplicate line is sent once', async () => {
    const list = [...ids(30), ids(1)[0] as string];
    const file = idsFile(list);
    await call(['--ids', `@${file}`]);
    const first = sentBodies();
    server.requests = [];
    await call(['--ids', `@${file}`]);
    expect(sentBodies()).toEqual(first);
    expect(sent().flatMap((a) => a.hg_ids)).toHaveLength(30);
  });

  it('reads stdin, skips blanks and # lines, trims whitespace and \\r, and reads a CSV column', async () => {
    const [a, b, c] = ids(3);
    const viaStdin = await call(['--ids', '-'], { input: `${a}\n${b}\n` });
    expect(rows(viaStdin).map((r) => r.input)).toEqual([a, b]);

    server.requests = [];
    const viaFile = await call(['--ids', `@${idsFile(`# my list\r\n  ${a}  \r\n\r\n#${b}\n${c}\r\n`)}`]);
    expect(rows(viaFile).map((r) => r.input)).toEqual([a, c]);
    expect(sent()[0]?.hg_ids).toEqual([a, c]);

    server.requests = [];
    const csv = `name,hg_id\r\n"Acme, ""The"" Co",${a}\r\n"multi\nline","${b}"\r\nempty,\r\n`;
    const viaCsv = await call(['--ids', `@${idsFile(csv, 'ids.csv')}`, '--ids-column', 'hg_id']);
    expect(viaCsv.code, viaCsv.stderr).toBe(0);
    expect(rows(viaCsv).map((r) => r.input)).toEqual([a, b]);
  });

  it("streams: batch 1's rows are on stdout before batch 2 is answered", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    setTool(batchTool(), async (args, n) => {
      if (n === 2) await held;
      return echo(args);
    });
    const list = ids(30);
    const live = startCli(['call', BATCH, '--ids', `@${idsFile(list)}`], sb.env);
    await live.waitForStdout(new RegExp(list[24] as string));
    await expect.poll(() => server.toolCalls().length).toBe(2);
    expect(live.child.exitCode).toBeNull();
    release();
    const res = await live.result();
    expect(res.code, res.stderr).toBe(0);
    expect(rows(res).map((r) => r.input)).toEqual(list);
  });

  it('JSONL is the default even on a terminal', async () => {
    const res = await runCliInPty(['call', BATCH, '--ids', `@${idsFile(ids(2))}`], sb.env);
    if (res === null) {
      console.warn('script(1) is not installed; skipping the TTY default-format check');
      return;
    }
    expect(res.code, res.stdout).toBe(0);
    const lines = res.stdout.split('\n').filter((l) => l.startsWith('{"input"'));
    expect(lines).toHaveLength(2);
    expect(res.stdout).not.toMatch(/input\s+result/);
  });

  it('-f json prints one array; --select trims result and keeps input and error; --out writes a new file', async () => {
    const [a, b] = ids(2);
    setTool(batchTool(), () => textResult({ companies: [{ company_id: a, name: 'A', employees: 5 }] }, 1));
    const asJson = await call(['--ids', `@${idsFile([a, b] as string[])}`, '-f', 'json', '--select', 'name']);
    expect(asJson.code, asJson.stderr).toBe(0);
    expect(JSON.parse(asJson.stdout)).toEqual([
      { input: a, result: { name: 'A' } },
      { input: b, error: { code: 'not_found', message: expect.any(String) } },
    ]);

    const out = path.join(sb.dir, 'rows.jsonl');
    const toFile = await call(['--ids', `@${idsFile([a] as string[])}`, '--out', out]);
    expect(toFile.code, toFile.stderr).toBe(0);
    expect(toFile.stdout).toBe('');
    expect(fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l))).toEqual([
      { input: a, result: { company_id: a, name: 'A', employees: 5 } },
    ]);
  });

  it('hgi run does not take --ids', async () => {
    const res = await runCli(['run', 'start_agent', '--ids', `@${idsFile(ids(1))}`], sb.env);
    expect(res.code).toBe(2);
    expect(errorBody(res).error.details?.reason).toBe('commander.unknownOption');
    expect(server.toolCalls()).toHaveLength(0);
  });

  it('refuses --ids @file for the credentials file, directly, via a symlink or via a hard link', async () => {
    const creds = path.join(sb.configDir, fs.readdirSync(sb.configDir).find((f) => f.startsWith('credentials-')) as string);
    const sym = path.join(sb.dir, 'sym.txt');
    fs.symlinkSync(creds, sym);
    const hard = path.join(sb.dir, 'hard.txt');
    fs.linkSync(creds, hard);
    for (const target of [creds, sym, hard]) {
      expectRefused(await call(['--ids', `@${target}`]), 'protected_path');
    }
  });
});

describe('Story 2: join the results back to my list', () => {
  it('an input with a leading zero matches an entry without it; the row keeps the input as given', async () => {
    const input = `0${'b'.repeat(31)}`;
    setTool(batchTool(), () => textResult({ companies: [{ company_id: 'B'.repeat(31), name: 'B' }] }, 1));
    const res = await call(['--ids', `@${idsFile([input])}`]);
    expect(rows(res)).toEqual([{ input, result: { company_id: 'B'.repeat(31), name: 'B' } }]);
  });

  it('matches on company_id, else requested_hg_id, else organization_id; domains on company_domain', async () => {
    const [a, b, c] = ids(3);
    setTool(batchTool({ domains: { type: 'array', items: { type: 'string' } } }), (args) =>
      textResult(
        args.domains
          ? { companies: [{ company_domain: 'example.com', n: 'd' }] }
          : { companies: [{ requested_hg_id: b, n: 'b', parent_id: a }, { organization_id: c, n: 'c' }, { company_id: a, n: 'a' }] },
        1,
      ),
    );
    const res = await call(['--ids', `@${idsFile([a, b, c, 'https://www.Example.com/about'] as string[])}`]);
    expect(res.code, res.stderr).toBe(0);
    expect(rows(res).map((r) => [r.input, r.result?.n])).toEqual([
      [a, 'a'],
      [b, 'b'],
      [c, 'c'],
      ['https://www.Example.com/about', 'd'],
    ]);
  });

  it('a repeated line repeats its row at each position', async () => {
    const [a, b] = ids(2) as [string, string];
    const res = await call(['--ids', `@${idsFile([a, b, a.toUpperCase(), a])}`]);
    expect(rows(res).map((r) => r.input)).toEqual([a, b, a.toUpperCase(), a]);
    expect(rows(res).every((r) => r.result)).toBe(true);
    expect(sent().flatMap((x) => x.hg_ids)).toEqual([a, b]);
  });

  it('a mixed file sends separate id and domain batches and prints every row in input order', async () => {
    setTool(batchTool({ domains: { type: 'array', items: { type: 'string' }, maxItems: 25 } }));
    const [a, b] = ids(2) as [string, string];
    const list = ['x.com', a, 'y.com', b];
    const res = await call(['--ids', `@${idsFile(list)}`]);
    expect(res.code, res.stderr).toBe(0);
    expect(sent()).toEqual([{ domains: ['x.com', 'y.com'] }, { hg_ids: [a, b] }]);
    expect(rows(res).map((r) => r.input)).toEqual(list);
  });

  it("reads entries from the output schema's array property, else a top-level companies array", async () => {
    const [a] = ids(1) as [string];
    setTool(
      batchTool({}, { outputSchema: { type: 'object', properties: { results: { type: 'array', items: { type: 'object' } }, total: { type: 'integer' } } } }),
      () => textResult({ results: [{ company_id: a, n: 1 }], total: 1 }, 1),
    );
    expect(rows(await call(['--ids', `@${idsFile([a])}`]))).toEqual([{ input: a, result: { company_id: a, n: 1 } }]);
  });
});

describe('Story 3: one bad id or one failed batch does not sink the run', () => {
  it('an id the server leaves out is not_found and the run exits 0', async () => {
    const [a, b] = ids(2) as [string, string];
    setTool(batchTool(), () => textResult({ companies: [{ company_id: a }], not_found: [b] }, 1));
    const res = await call(['--ids', `@${idsFile([a, b])}`]);
    expect(res.code, res.stderr).toBe(0);
    expect(rows(res)[1]).toEqual({ input: b, error: { code: 'not_found', message: expect.any(String) } });
  });

  it('a failed middle batch gives its rows the tool error; the others still run; exit 3 with details', async () => {
    setTool(batchTool(), (args, n) => (n === 2 ? { isError: true, content: [{ type: 'text', text: 'batch exploded' }] } : echo(args)));
    const list = ids(60);
    const res = await call(['--ids', `@${idsFile(list)}`]);
    expect(res.code).toBe(3);
    const out = rows(res);
    expect(out).toHaveLength(60);
    expect(out.slice(25, 50).every((r) => r.error?.code === 'tool_error' && r.error.message === 'batch exploded')).toBe(true);
    expect(out.slice(0, 25).concat(out.slice(50)).every((r) => r.result)).toBe(true);
    expect(server.toolCalls()).toHaveLength(3);
    expect(errorBody(res).error.details).toMatchObject({ failed_batches: 1, rows_emitted: 60, calls_made: 3 });
  });

  it('a response with neither the schema-named array nor companies is unexpected_response, exit 3', async () => {
    setTool(batchTool(), () => textResult({ something_else: [] }, 1));
    const res = await call(['--ids', `@${idsFile(ids(2))}`]);
    expect(res.code).toBe(3);
    expect(rows(res).map((r) => r.error?.code)).toEqual(['unexpected_response', 'unexpected_response']);
  });

  it('a JSON-RPC error carrying tokens is redacted in the rows, on stderr and in --out', async () => {
    const { access_token, refresh_token } = readCreds(sb);
    const leak = () => server.faults.push({ match: { rpcMethod: 'tools/call' }, status: 200, rpcError: { code: -32603, message: `boom ${access_token} ${refresh_token}` }, times: 1 });
    leak();
    const res = await call(['--ids', `@${idsFile(ids(2))}`]);
    expect(res.code).toBe(3);
    expect(rows(res)[0]?.error?.code).toBe('tool_error');
    leak();
    const out = path.join(sb.dir, 'leak.jsonl');
    const toFile = await call(['--ids', `@${idsFile(ids(2))}`, '--out', out]);
    expect(toFile.code).toBe(3);
    for (const text of [res.stdout, res.stderr, toFile.stdout, toFile.stderr, fs.readFileSync(out, 'utf8')]) {
      expect(text).not.toContain(access_token);
      expect(text).not.toContain(refresh_token);
    }
    expect(fs.readFileSync(out, 'utf8')).toContain('[REDACTED]');
  });
});

describe('Story 4: a run that has to stop, stops cleanly', () => {
  it('a credit limit on batch 2 of 3 exits 6 at once; batch 1 rows stay; batch 3 is never sent', async () => {
    setTool(batchTool(), (args, n) => (n === 2 ? creditLimit() : echo(args)));
    const list = ids(60);
    const res = await call(['--ids', `@${idsFile(list)}`]);
    expect(res.code).toBe(6);
    expect(rows(res).map((r) => r.input)).toEqual(list.slice(0, 25));
    expect(server.toolCalls()).toHaveLength(2);
    expect(errorBody(res).error.details).toMatchObject({ rows_emitted: 25, calls_made: 2 });
  });

  it('a 401 that survives refresh on batch 2 exits 4 and stops', async () => {
    setTool(batchTool(), (args, n) => {
      if (n === 1) {
        server.faults.push({ match: { path: '/api/ai/mcp' }, status: 401, body: { jsonrpc: '2.0', error: { code: -32603, message: 'Unauthorized' }, id: null }, times: 20 });
      }
      return echo(args);
    });
    const res = await call(['--ids', `@${idsFile(ids(60))}`]);
    expect(res.code).toBe(4);
    expect(rows(res)).toHaveLength(25);
    expect(server.toolCalls().length).toBeLessThanOrEqual(3);
    expect(errorBody(res).error.details).toMatchObject({ rows_emitted: 25, calls_made: 2 });
  });

  it('a connection dropped after batch 2 was sent is outcome_unknown, not retried, and stops', async () => {
    setTool(batchTool(), (args, n) => {
      if (n === 1) server.faults.push({ match: { rpcMethod: 'tools/call' }, status: 0, destroy: true, times: 5 });
      return echo(args);
    });
    const res = await call(['--ids', `@${idsFile(ids(60))}`]);
    expect(res.code).not.toBe(0);
    expect(res.code).not.toBe(3);
    const err = errorBody(res).error;
    expect(err.details).toMatchObject({ outcome_unknown: true, rows_emitted: 25, calls_made: 2 });
    expect(server.toolCalls()).toHaveLength(2);
    expect(rows(res)).toHaveLength(25);
  });

  it('with --out, a fatal stop writes the rows so far and still reports its own exit code', async () => {
    setTool(batchTool(), (args, n) => (n === 2 ? creditLimit() : echo(args)));
    const out = path.join(sb.dir, 'partial.jsonl');
    const res = await call(['--ids', `@${idsFile(ids(60))}`, '--out', out]);
    expect(res.code).toBe(6);
    expect(fs.readFileSync(out, 'utf8').trim().split('\n')).toHaveLength(25);
  });

  it('with --out, if the file cannot be written on a fatal stop, the rows go to stdout and the exit code is kept', async () => {
    const out = path.join(sb.dir, 'raced.jsonl');
    setTool(batchTool(), (args, n) => {
      if (n === 2) {
        fs.writeFileSync(out, 'someone else');
        return creditLimit();
      }
      return echo(args);
    });
    const res = await call(['--ids', `@${idsFile(ids(60))}`, '--out', out]);
    expect(res.code).toBe(6);
    expect(errorBody(res).error.details).toMatchObject({ out_write_failed: true, rows_emitted: 25 });
    expect(rows(res)).toHaveLength(25);
    expect(fs.readFileSync(out, 'utf8')).toBe('someone else');
  });

  it('never has two tools/call requests in flight', async () => {
    setTool(batchTool(), async (args) => {
      await new Promise((r) => setTimeout(r, 20));
      return echo(args);
    });
    expect((await call(['--ids', `@${idsFile(ids(80))}`])).code).toBe(0);
    expect(server.toolCalls()).toHaveLength(4);
    expect(server.maxInFlight).toBe(1);
  });
});

describe('Story 5: mistakes are caught before anything is billed', () => {
  it('a domain against a tool with only hg_ids exits 2', async () => {
    expectRefused(await call(['--ids', `@${idsFile([ids(1)[0] as string, 'example.com'])}`]), 'unsupported_kind');
  });

  it('conflicting or bad flags exit 2 with nothing sent', async () => {
    const file = idsFile(ids(3));
    expectRefused(await call(['--ids', `@${file}`, '--input', '{"hg_ids":["x"]}']), 'ids_conflict');
    expectRefused(await call(['--ids', `@${file}`, '--input', '{"domains":["x.com"]}']), 'ids_conflict');
    expectRefused(await call(['--ids', '-', '--input', '-'], { input: 'a1\n' }), 'stdin_conflict');
    expectRefused(await call(['--ids', `@${idsFile('# nothing\n\n   \n', 'empty.txt')}`]), 'no_ids');
    for (const size of ['0', '2.5', '26']) expectRefused(await call(['--ids', `@${file}`, '--batch-size', size]), 'bad_batch_size');
    expectRefused(await call(['--ids', `@${idsFile('hg_id\na1\n', 'x.csv')}`, '--ids-column', 'missing']), 'unknown_column');
    expectRefused(await call(['--ids-column', 'hg_id', '--input', '{}']), 'ids_column_without_ids');
    expectRefused(await call(['--batch-size', '5', '--input', '{}']), 'batch_size_without_ids');
    expectRefused(await call(['--ids', file]), 'bad_ids_source');
  });

  it('--batch-size may not exceed the limit of any field the input uses', async () => {
    setTool(batchTool({ domains: { type: 'array', items: { type: 'string' }, maxItems: 10 } }));
    const res = await call(['--ids', `@${idsFile([ids(1)[0] as string, 'x.com'])}`, '--batch-size', '20']);
    expectRefused(res, 'bad_batch_size');
    expect(errorBody(res).error.details).toMatchObject({ field: 'domains', max: 10 });
    expect((await call(['--ids', `@${idsFile(ids(3))}`, '--batch-size', '20'])).code).toBe(0);
  });

  it('an unusable maxItems is refused, even with --no-validate', async () => {
    for (const maxItems of [0, 'x']) {
      setTool(batchTool({ hg_ids: { type: 'array', items: { type: 'string' }, maxItems } }));
      expectRefused(await call(['--ids', `@${idsFile(ids(2))}`]), 'unusable_max_items');
      expectRefused(await call(['--ids', `@${idsFile(ids(2))}`, '--no-validate']), 'unusable_max_items');
    }
  });

  it('every batch is schema-checked before the first call: a bad id in batch 3 stops batch 1 going out', async () => {
    setTool(batchTool({ hg_ids: { type: 'array', items: { type: 'string', pattern: '^a[0-9]+$' }, maxItems: 25 } }));
    const res = await call(['--ids', `@${idsFile([...ids(50), 'zzz'])}`]);
    expectRefused(res, 'schema');
    expect(errorBody(res).error.details?.batch).toBe(3);
  });
});

describe('Story 6: know what the run cost', () => {
  it('three batches costing 2, 3 and 4 print one credit line, 9; no reported costs print null', async () => {
    setTool(batchTool(), (args, n) => echo(args, n + 1));
    const res = await call(['--ids', `@${idsFile(ids(60))}`]);
    expect(stderrJsonLines(res).filter((l) => 'credit_cost' in l && Object.keys(l).length === 1)).toEqual([{ credit_cost: 9 }]);

    setTool(batchTool(), (args) => echo(args, null));
    const free = await call(['--ids', `@${idsFile(ids(2))}`]);
    expect(stderrJsonLines(free)).toEqual([{ credit_cost: null }]);
  });

  it('--meta prints a summary on stderr and leaves stdout as pure rows', async () => {
    const [a] = ids(1) as [string];
    setTool(batchTool(), (args, n) => (n === 2 ? textResult({ companies: [] }, null) : echo(args, 2)));
    const list = [a, ...ids(50, 100)];
    const res = await call(['--ids', `@${idsFile(list)}`, '--meta']);
    expect(res.code, res.stderr).toBe(0);
    expect(rows(res)).toHaveLength(51);
    expect(rows(res).every((r) => typeof r.input === 'string')).toBe(true);
    const summary = stderrJsonLines(res).find((l) => 'calls' in l);
    expect(summary).toEqual({ calls: 3, rows: 51, row_errors: 25, credit_cost: 4, calls_without_cost: 1 });
  });

  it('with stderr not a terminal, there are no progress lines', async () => {
    const res = await call(['--ids', `@${idsFile(ids(60))}`]);
    expect(res.stderr).not.toMatch(/batch \d+\/\d+/);
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeSandbox, runCli, type CliResult, type Sandbox } from '../support/cli.js';
import { errorBody, login, seedServer } from '../support/e2e.js';
import { FakeServer, textResult, type ToolResult } from '../support/fake-server.js';
import {
  BATCH_TOOL,
  CREDIT_LIMIT,
  HAS_MORE_TOOL,
  IDS_BATCH_TOOL,
  PAGE_NUMBER_TOOL,
  SPEND_LIKE_TOOL,
  SPLIT_ARRAYS_TOOL,
  TOP_TOOL,
  batchHandler,
  topHandler,
} from '../support/paging-fixtures.js';

const server = new FakeServer();
let sb: Sandbox;

beforeAll(() => server.start());
afterAll(() => server.stop());
beforeEach(async () => {
  seedServer(server);
  server.tools.push(TOP_TOOL, HAS_MORE_TOOL, BATCH_TOOL, SPEND_LIKE_TOOL, PAGE_NUMBER_TOOL);
  sb = makeSandbox(server.base, { HGI_BUDGET_ID: 'paging' });
  await login(sb);
});
afterEach(() => sb.cleanup());

const call = (tool: string, input: unknown, args: string[] = [], env = sb.env) =>
  runCli(['call', tool, '--input', JSON.stringify(input), ...args], env);

/** The arguments of every `tools/call` the fake server received, in order. */
const sentArgs = () =>
  server.toolCalls().map((r) => (JSON.parse(r.body ?? '{}') as { params: { arguments: Record<string, unknown> } }).params.arguments);

const json = (res: CliResult) => {
  expect(res.code, res.stderr).toBe(0);
  return JSON.parse(res.stdout) as Record<string, unknown>;
};

const ns = (list: unknown) => (list as Array<{ n: number }>).map((r) => r.n);
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

function creditLines(stderr: string): string[] {
  return stderr.split('\n').filter((l) => l.includes('credit_cost'));
}

function expectError(res: CliResult, exit: number, code: string) {
  expect(res.code, res.stderr).toBe(exit);
  const { error } = errorBody(res);
  expect(error.code).toBe(code);
  return error;
}

describe('Story 1: every row in one result', () => {
  it('stops at the total even though has_more says true at the exact page boundary', async () => {
    server.handlers.set('list_widgets', topHandler({ rows: 6, hasMore: true }));
    const out = json(await call('list_widgets', { q: 'x' }, ['--all-pages']));
    expect(ns(out.widgets)).toEqual(range(6));
    expect(sentArgs()).toEqual([{ q: 'x' }, { q: 'x', offset: 3 }]);
    expect(out).toMatchObject({ pages_fetched: 2, has_more: true, total: 6, note: 'page at 3' });
    expect(out.truncated).toBeUndefined();
  });

  it('stops on a short page even though has_more says true', async () => {
    server.handlers.set('list_widgets', topHandler({ rows: 7, total: null, hasMore: true }));
    const out = json(await call('list_widgets', {}, ['--all-pages']));
    expect(ns(out.widgets)).toEqual(range(7));
    expect(sentArgs().map((a) => a.offset)).toEqual([undefined, 3, 6]);
  });

  it('without a total or page size, pages until has_more is false, or an empty page', async () => {
    const pages = [[0, 1], [2, 3], [4]];
    let i = 0;
    server.handlers.set('list_events', () => {
      const page = pages[i] ?? [];
      i += 1;
      return textResult({ events: page.map((n) => ({ n })), hasMore: i < pages.length }, 1);
    });
    let out = json(await call('list_events', {}, ['--all-pages']));
    expect(ns(out.events)).toEqual(range(5));
    expect(sentArgs().map((a) => a.offset)).toEqual([undefined, 2, 4]);

    server.reset();
    i = 0;
    server.handlers.set('list_events', () => {
      const page = pages[i] ?? [];
      i += 1;
      return textResult({ events: page.map((n) => ({ n })), hasMore: true }, 1);
    });
    await login(sb);
    out = json(await call('list_events', {}, ['--all-pages']));
    expect(ns(out.events)).toEqual(range(5));
    expect(sentArgs().map((a) => a.offset)).toEqual([undefined, 2, 4, 5]);
    expect(out.pages_fetched).toBe(4);
  });

  it('batch: follows up only unfinished companies, one per call, and matches ids that lost their leading zeros', async () => {
    server.handlers.set('company_widgets', batchHandler({ companies: { '00a1': 2, '0b2': 5, c3: 3 }, dropLeadingZeros: true }));
    const out = json(await call('company_widgets', { hg_ids: ['00a1', '0b2', 'c3'], vendor: 'v' }, ['--all-pages']));
    expect(sentArgs()).toEqual([
      { hg_ids: ['00a1', '0b2', 'c3'], vendor: 'v' },
      { hg_ids: ['0b2'], vendor: 'v', offset: 2 },
      { hg_ids: ['0b2'], vendor: 'v', offset: 4 },
      { hg_ids: ['c3'], vendor: 'v', offset: 2 },
    ]);
    const companies = out.companies as Array<Record<string, unknown>>;
    expect(companies.map((c) => [c.company_id, ns(c.installs), c.pages_fetched])).toEqual([
      ['a1', [0, 1], 1],
      ['b2', [0, 1, 2, 3, 4], 3],
      ['c3', [0, 1, 2], 2],
    ]);
    // Scalars reflect the last page fetched for that company.
    expect(companies[1]).toMatchObject({ installs_count: 1, has_more: true });
  });

  it('batch: one id, or no ids returning one company, pages with the original input plus offset', async () => {
    server.handlers.set('company_widgets', batchHandler({ companies: { a1: 5, d4: 3 }, fallback: 'd4' }));
    let out = json(await call('company_widgets', { hg_ids: ['a1'] }, ['--all-pages']));
    expect(ns((out.companies as Array<Record<string, unknown>>)[0]?.installs)).toEqual(range(5));
    expect(sentArgs()).toEqual([{ hg_ids: ['a1'] }, { hg_ids: ['a1'], offset: 2 }, { hg_ids: ['a1'], offset: 4 }]);

    server.reset();
    await login(sb);
    out = json(await call('company_widgets', { vendor: 'v' }, ['--all-pages']));
    expect(ns((out.companies as Array<Record<string, unknown>>)[0]?.installs)).toEqual(range(3));
    expect(sentArgs()).toEqual([{ vendor: 'v' }, { vendor: 'v', offset: 2 }]);
  });

  it('domains split per company too, as the caller wrote them', async () => {
    server.handlers.set('company_widgets', (args) => {
      const domains = (args.domains as string[] | undefined) ?? [];
      const offset = typeof args.offset === 'number' ? args.offset : 0;
      return textResult(
        {
          companies: domains.map((d) => ({
            company_domain: d.replace(/^https?:\/\/(www\.)?/, '').toUpperCase(),
            installs: offset === 0 ? [{ n: 0 }, { n: 1 }] : [{ n: 2 }],
            total_installs_count: 3,
          })),
        },
        1,
      );
    });
    const out = json(await call('company_widgets', { domains: ['https://www.acme.com', 'beta.io'] }, ['--all-pages']));
    expect(sentArgs().slice(1)).toEqual([
      { domains: ['https://www.acme.com'], offset: 2 },
      { domains: ['beta.io'], offset: 2 },
    ]);
    expect((out.companies as Array<Record<string, unknown>>).map((c) => ns(c.installs))).toEqual([range(3), range(3)]);
  });

  it('keeps the merged shape for -f jsonl, --select and --out', async () => {
    server.handlers.set('list_widgets', topHandler({ rows: 5 }));
    const jsonl = await call('list_widgets', {}, ['--all-pages', '-f', 'jsonl']);
    expect(jsonl.code, jsonl.stderr).toBe(0);
    expect(jsonl.stdout.trim().split('\n').map((l) => (JSON.parse(l) as { n: number }).n)).toEqual(range(5));

    const selected = json(await call('list_widgets', {}, ['--all-pages', '--select', 'widgets.n,pages_fetched']));
    expect(selected).toEqual({ widgets: range(5).map((n) => ({ n })), pages_fetched: 2 });

    const file = path.join(sb.dir, 'all.json');
    const res = await call('list_widgets', {}, ['--all-pages', '--out', file]);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toBe('');
    expect(ns((JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>).widgets)).toEqual(range(5));
  });

  it('prints one credit line with the sum; --meta adds pages_fetched and calls_without_cost', async () => {
    server.handlers.set('list_widgets', topHandler({ rows: 7, cost: 2 }));
    const res = await call('list_widgets', {}, ['--all-pages', '--meta']);
    const meta = json(res);
    expect(creditLines(res.stderr)).toEqual(['{"credit_cost":6}']);
    expect(meta).toMatchObject({ credit_cost: 6, mcp_version: 'v2', pages_fetched: 3, calls_without_cost: 0 });
    expect(ns((meta.result as Record<string, unknown>).widgets)).toEqual(range(7));

    server.handlers.set('list_widgets', topHandler({ rows: 4, cost: null }));
    const free = await call('list_widgets', {}, ['--all-pages', '--meta']);
    expect(json(free)).toMatchObject({ credit_cost: null, pages_fetched: 2, calls_without_cost: 2 });
    expect(creditLines(free.stderr)).toEqual(['{"credit_cost":null}']);
  });

  it('fetches pages one at a time, never concurrently', async () => {
    server.handlers.set('list_widgets', topHandler({ rows: 9, delayMs: 30 }));
    expect((await call('list_widgets', {}, ['--all-pages'])).code).toBe(0);
    server.handlers.set('company_widgets', batchHandler({ companies: { a1: 6, b2: 6 }, delayMs: 30 }));
    expect((await call('company_widgets', { hg_ids: ['a1', 'b2'] }, ['--all-pages'])).code).toBe(0);
    expect(server.toolCalls().length).toBe(3 + 1 + 4);
    expect(server.maxInFlight).toBe(1);
  });
});

describe('Story 2: a cap on what a run can spend', () => {
  it('--max-pages 2 stops at 2 pages and marks the result truncated; exit 0', async () => {
    server.handlers.set('list_widgets', topHandler({ rows: 30 }));
    const out = json(await call('list_widgets', {}, ['--all-pages', '--max-pages', '2']));
    expect(server.toolCalls().length).toBe(2);
    expect(out).toMatchObject({ pages_fetched: 2, truncated: true, truncated_reason: 'max_pages' });
    expect(ns(out.widgets)).toEqual(range(6));
  });

  it('the default cap is 10 pages', async () => {
    server.handlers.set('list_widgets', topHandler({ rows: 36 }));
    const out = json(await call('list_widgets', {}, ['--all-pages']));
    expect(server.toolCalls().length).toBe(10);
    expect(out).toMatchObject({ pages_fetched: 10, truncated: true, truncated_reason: 'max_pages' });
  });

  it('--max-pages applies to each company on its own', async () => {
    server.handlers.set('company_widgets', batchHandler({ companies: { a1: 10, b2: 10, c3: 10 } }));
    const out = json(await call('company_widgets', { hg_ids: ['a1', 'b2', 'c3'] }, ['--all-pages', '--max-pages', '2']));
    expect(server.toolCalls().length).toBe(4);
    for (const c of out.companies as Array<Record<string, unknown>>) {
      expect(c).toMatchObject({ pages_fetched: 2, truncated: true, truncated_reason: 'max_pages' });
      expect(ns(c.installs)).toEqual(range(4));
    }
  });

  it('help: call shows both options and the billing note; run shows neither', async () => {
    const help = await runCli(['call', '--help'], sb.env);
    expect(help.stdout).toContain('--all-pages');
    expect(help.stdout).toContain('--max-pages <n>');
    expect(help.stdout).toMatch(/each extra page is a separate,\s+billed\s+call/i);
    expect(help.stdout).toMatch(/one call per company/);
    const run = await runCli(['run', '--help'], sb.env);
    expect(run.stdout).not.toContain('--all-pages');
    expect(run.stdout).not.toContain('--max-pages');
  });

  it('the run cap is checked before every page: page 3 is not sent, the partial result is printed, exit 13', async () => {
    server.handlers.set('list_widgets', topHandler({ rows: 30, cost: 1 }));
    const res = await call('list_widgets', {}, ['--all-pages', '--max-credits', '2']);
    const error = expectError(res, 13, 'budget_exceeded');
    expect(error.details).toMatchObject({ partial_result: true, pages_fetched: 2 });
    expect(server.toolCalls().length).toBe(2);
    const out = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(ns(out.widgets)).toEqual(range(6));
    expect(out).toMatchObject({ truncated: true, truncated_reason: 'budget_exceeded' });
    expect(creditLines(res.stderr)[0]).toBe('{"credit_cost":2}');
  });
});

describe('Story 3: a failure does not throw away what was paid for', () => {
  it('a credit limit on page 3 keeps pages 1-2 on stdout and exits 6, without a retry', async () => {
    server.handlers.set('list_widgets', topHandler({ rows: 30, special: { 3: CREDIT_LIMIT } }));
    const res = await call('list_widgets', {}, ['--all-pages']);
    const error = expectError(res, 6, 'credit_limit_exceeded');
    expect(error.details).toMatchObject({ partial_result: true, pages_fetched: 3 });
    expect(server.toolCalls().length).toBe(3);
    const out = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(ns(out.widgets)).toEqual(range(6));
    expect(out).toMatchObject({ pages_fetched: 2, truncated: true, truncated_reason: 'credit_limit_exceeded' });
  });

  it('a partial result goes through --meta and --select like a full one', async () => {
    server.handlers.set('list_widgets', topHandler({ rows: 30, special: { 3: CREDIT_LIMIT } }));
    const res = await call('list_widgets', {}, ['--all-pages', '--meta', '--select', 'widgets.n,truncated_reason']);
    expectError(res, 6, 'credit_limit_exceeded');
    const meta = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(meta).toEqual({
      result: { widgets: range(6).map((n) => ({ n })), truncated_reason: 'credit_limit_exceeded' },
      credit_cost: 2,
      mcp_version: 'v2',
      pages_fetched: 3,
      retries: 0,
      calls_without_cost: 1,
    });
  });

  it('a failure on page 1 behaves exactly like a single call', async () => {
    server.handlers.set('list_widgets', topHandler({ rows: 30, special: { 1: CREDIT_LIMIT, 2: CREDIT_LIMIT } }));
    const paged = await call('list_widgets', {}, ['--all-pages']);
    const single = await call('list_widgets', {}, []);
    expect(paged.stdout).toBe('');
    expect(paged.code).toBe(single.code);
    expect(errorBody(paged)).toEqual(errorBody(single));
  });

  describe('when the run cap cannot record a page', () => {
    const budgets = () => path.join(sb.configDir, 'budgets');
    /** Makes the budgets directory read-only while call `n` runs, so its spend cannot be recorded. */
    const lockOnCall = (n: number) => {
      const inner = topHandler({ rows: 30 });
      let count = 0;
      server.handlers.set('list_widgets', async (args) => {
        count += 1;
        if (count === n) fs.chmodSync(budgets(), 0o500);
        return inner(args);
      });
    };
    afterEach(() => {
      try {
        fs.chmodSync(budgets(), 0o700);
      } catch {
        // never created
      }
    });

    it('on page 1: exactly what hgi call does (page 1 on stdout, exit 12 tool_ran, no paging fields)', async () => {
      lockOnCall(1);
      const paged = await call('list_widgets', {}, ['--all-pages', '--max-credits', '50'], { ...sb.env, HGI_BUDGET_ID: 'p1' });
      fs.chmodSync(budgets(), 0o700);
      lockOnCall(1);
      const single = await call('list_widgets', {}, ['--max-credits', '50'], { ...sb.env, HGI_BUDGET_ID: 'p2' });
      expect(paged.code, paged.stderr).toBe(12);
      expect(paged.stdout).toBe(single.stdout);
      expect(errorBody(paged)).toEqual(errorBody(single));
      expect(errorBody(paged).error.details).not.toHaveProperty('partial_result');
    });

    it('on a later page: the pages so far on stdout, exit 12 tool_ran with partial_result', async () => {
      lockOnCall(2);
      const res = await call('list_widgets', {}, ['--all-pages', '--max-credits', '50']);
      const error = expectError(res, 12, 'local_state_error');
      expect(error.details).toMatchObject({ kind: 'budget_write_failed', tool_ran: true, partial_result: true, pages_fetched: 2 });
      expect(server.toolCalls().length).toBe(2);
      const out = JSON.parse(res.stdout) as Record<string, unknown>;
      expect(ns(out.widgets)).toEqual(range(6));
      expect(out).toMatchObject({ pages_fetched: 2, truncated: true, truncated_reason: 'local_state_error' });
    });
  });

  it('a malformed later page stops with exit 3 and keeps page 1', async () => {
    server.handlers.set('list_widgets', topHandler({ rows: 30, special: { 2: textResult({ oops: true }, 1) } }));
    const res = await call('list_widgets', {}, ['--all-pages']);
    const error = expectError(res, 3, 'tool_error');
    expect(error.details).toMatchObject({ reason: 'unexpected_response', partial_result: true, pages_fetched: 2 });
    expect(JSON.parse(res.stdout)).toMatchObject({ widgets: range(3).map((n) => ({ n })), truncated_reason: 'tool_error' });
  });

  it('an entry matching no input is marked unmatched and not followed up; the others still page', async () => {
    const stray = { company_id: 'zz9', installs: [{ n: 0 }, { n: 1 }], total_installs_count: 9, has_more: true };
    server.handlers.set('company_widgets', batchHandler({ companies: { a1: 3, b2: 2 }, extra: [stray] }));
    const out = json(await call('company_widgets', { hg_ids: ['a1', 'b2'] }, ['--all-pages']));
    expect(sentArgs().slice(1)).toEqual([{ hg_ids: ['a1'], offset: 2 }]);
    const companies = out.companies as Array<Record<string, unknown>>;
    expect(companies[0]).toMatchObject({ company_id: 'a1', pages_fetched: 2 });
    expect(companies[0]?.truncated).toBeUndefined();
    expect(companies[1]?.truncated).toBeUndefined();
    expect(companies[2]).toMatchObject({ company_id: 'zz9', pages_fetched: 1, truncated: true, truncated_reason: 'unmatched' });
  });
});

describe('a single company is never mixed with another', () => {
  const entry = (id: string, offset: number) => ({ company_id: id, installs: [{ n: offset }, { n: offset + 1 }], total_installs_count: 9, has_more: true });

  it('page 1 answers for another company: unmatched, not followed up', async () => {
    server.handlers.set('company_widgets', () => textResult({ companies: [entry('other', 0)] }, 1));
    const out = json(await call('company_widgets', { hg_ids: ['a1'] }, ['--all-pages']));
    expect(server.toolCalls().length).toBe(1);
    expect((out.companies as Array<Record<string, unknown>>)[0]).toMatchObject({ company_id: 'other', truncated: true, truncated_reason: 'unmatched' });
  });

  it('a follow-up answers for another company: its rows are not merged, the entry is unmatched', async () => {
    server.handlers.set('company_widgets', (args) => textResult({ companies: [entry(args.offset ? 'other' : '0A1', Number(args.offset ?? 0))] }, 1));
    const out = json(await call('company_widgets', { hg_ids: ['a1'] }, ['--all-pages']));
    expect(server.toolCalls().length).toBe(2);
    const company = (out.companies as Array<Record<string, unknown>>)[0];
    expect(company).toMatchObject({ company_id: '0A1', pages_fetched: 1, truncated: true, truncated_reason: 'unmatched' });
    expect(ns(company?.installs)).toEqual([0, 1]);
  });
});

describe('Story 4: refused up front, nothing sent', () => {
  it.each([
    ['company_outlay', { hg_ids: ['a1'] }],
    ['people_search', {}],
  ])('%s is not pageable', async (tool, input) => {
    const error = expectError(await call(tool, input, ['--all-pages']), 2, 'invalid_input');
    expect(error.details).toMatchObject({ reason: 'not_pageable', tool });
    expect(server.toolCalls()).toEqual([]);
  });

  it.each<[string, string[], unknown, string]>([
    ['--max-pages without --all-pages', ['--max-pages', '3'], {}, 'max_pages_without_all_pages'],
    ['--max-pages 0', ['--all-pages', '--max-pages', '0'], {}, 'bad_max_pages'],
    ['--max-pages not a number', ['--all-pages', '--max-pages', '2.5'], {}, 'bad_max_pages'],
    ['offset in --input', ['--all-pages'], { offset: 3 }, 'offset_with_all_pages'],
  ])('%s', async (_name, args, input, reason) => {
    const error = expectError(await call('list_widgets', input, args), 2, 'invalid_input');
    expect(error.details?.reason).toBe(reason);
    expect(server.toolCalls()).toEqual([]);
  });

  it.each([
    ['no rows array per company', SPEND_LIKE_TOOL],
    ['pageable entries in another array than the one --ids reads', SPLIT_ARRAYS_TOOL],
  ])('--ids with --all-pages: %s is not_pageable, nothing sent', async (_name, tool) => {
    server.tools.push(SPLIT_ARRAYS_TOOL);
    const ids = path.join(sb.dir, 'ids.txt');
    fs.writeFileSync(ids, 'a1\nb2\n');
    const error = expectError(await runCli(['call', tool.name, '--all-pages', '--ids', `@${ids}`], sb.env), 2, 'invalid_input');
    expect(error.details).toMatchObject({ reason: 'not_pageable', tool: tool.name });
    expect(server.toolCalls()).toEqual([]);
  });
});

describe('issue #32: --retries with --all-pages', () => {
  const GOVERNANCE: ToolResult = {
    isError: true,
    content: [{ type: 'text', text: 'Budget service down.' }],
    _meta: { errorCode: 'governance_unavailable' },
  };

  it('a page that gets governance_unavailable once is re-sent; --meta counts pages and retries apart', async () => {
    server.handlers.set('list_widgets', topHandler({ rows: 7, cost: 2, special: { 2: GOVERNANCE } }));
    const res = await call('list_widgets', {}, ['--all-pages', '--retries', '2', '--meta']);
    const meta = json(res);
    expect(meta).toMatchObject({ credit_cost: 6, pages_fetched: 3, retries: 1, calls_without_cost: 0 });
    expect(ns((meta.result as Record<string, unknown>).widgets)).toEqual(range(7));
    expect(sentArgs().map((a) => a.offset)).toEqual([undefined, 3, 3, 6]);
    const retryLines = res.stderr.split('\n').filter((l) => l.includes('"retry"'));
    expect(retryLines).toHaveLength(1);
    expect(JSON.parse(retryLines[0] ?? '{}')).toMatchObject({ retry: { code: 'governance_unavailable', attempt: 1, max: 2 } });
  });

  it('when a later page runs out of governance retries: the pages so far, exit 7 with attempts and partial_result', async () => {
    server.handlers.set('list_widgets', topHandler({ rows: 30, special: { 2: GOVERNANCE, 3: GOVERNANCE } }));
    const res = await call('list_widgets', {}, ['--all-pages', '--retries', '1']);
    const error = expectError(res, 7, 'governance_unavailable');
    expect(error.details).toMatchObject({ retryable: true, attempts: 2, partial_result: true, pages_fetched: 2 });
    expect(server.toolCalls()).toHaveLength(3);
    const out = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(ns(out.widgets)).toEqual(range(3));
    expect(out).toMatchObject({ truncated: true, truncated_reason: 'governance_unavailable' });
  });

  it('without --retries a page is not re-sent on governance_unavailable', async () => {
    server.handlers.set('list_widgets', topHandler({ rows: 30, special: { 2: GOVERNANCE } }));
    const res = await call('list_widgets', {}, ['--all-pages']);
    expectError(res, 7, 'governance_unavailable');
    expect(server.toolCalls()).toHaveLength(2);
  });
});

describe('--ids with --all-pages', () => {
  const TOOL = IDS_BATCH_TOOL.name;
  type Row = { input: string; result?: Record<string, unknown>; error?: { code: string } };

  beforeEach(() => {
    server.tools = server.tools.filter((t) => t.name !== TOOL).concat(IDS_BATCH_TOOL);
  });

  const idsFile = (lines: string[]) => {
    const file = path.join(sb.dir, 'ids.txt');
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    return file;
  };
  const both = (lines: string[], args: string[] = [], env = sb.env) =>
    runCli(['call', TOOL, '--ids', `@${idsFile(lines)}`, '--all-pages', ...args], env);
  const rowsOf = (res: CliResult): Row[] =>
    res.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Row);
  const summary = (res: CliResult) => {
    const line = res.stderr.split('\n').find((l) => l.startsWith('{"calls"'));
    return line === undefined ? undefined : (JSON.parse(line) as Record<string, unknown>);
  };
  const toolError = { content: [{ type: 'text' as const, text: 'Upstream lookup failed.' }], isError: true };
  /** Company i: 1 row (a short page), 2 rows (exactly one page, has_more true, total reached) or 5 rows (3 pages). */
  const counts = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`co${i}`, [1, 2, 5][i % 3] as number]));
  const names = (n: number) => Array.from({ length: n }, (_, i) => `co${i}`);
  const followUps = (from: number, to: number) =>
    names(to)
      .slice(from)
      .filter((_, k) => (from + k) % 3 === 2)
      .flatMap((id) => [
        { hg_ids: [id], offset: 2 },
        { hg_ids: [id], offset: 4 },
      ]);

  it('Story 1: 30 ids send 2 batches, follow-ups only for unfinished companies, one per call; 30 rows in input order', async () => {
    server.handlers.set(TOOL, batchHandler({ companies: counts(30) }));
    const res = await both(names(30));
    expect(res.code, res.stderr).toBe(0);
    expect(sentArgs()).toEqual([{ hg_ids: names(25) }, ...followUps(0, 25), { hg_ids: names(30).slice(25) }, ...followUps(25, 30)]);
    const rows = rowsOf(res);
    expect(rows.map((r) => r.input)).toEqual(names(30));
    rows.forEach((r, i) => {
      const n = [1, 2, 5][i % 3] as number;
      expect(ns(r.result?.installs)).toEqual(range(n));
      expect(r.result).toMatchObject({ company_id: `co${i}`, pages_fetched: n === 5 ? 3 : 1 });
      expect(r.result?.truncated).toBeUndefined();
    });
    expect(server.maxInFlight).toBe(1);
  });

  it('Story 1 (stop rule): exactly page-size rows with has_more true and the total reached gets no follow-up', async () => {
    server.handlers.set(TOOL, batchHandler({ companies: { exact: 2, long: 3 } }));
    const res = await both(['exact', 'long']);
    expect(res.code, res.stderr).toBe(0);
    expect(sentArgs()).toEqual([{ hg_ids: ['exact', 'long'] }, { hg_ids: ['long'], offset: 2 }]);
    expect(rowsOf(res)[0]?.result).toMatchObject({ has_more: true, total_installs_count: 2, pages_fetched: 1 });
  });

  it('Story 1 (max pages, credits): --max-pages per company marks truncated rows; one summed credit line; --meta counts follow-ups and truncated rows', async () => {
    server.handlers.set(TOOL, batchHandler({ companies: { a1: 10, b2: 1, c3: 4, d4: 10 } }));
    const res = await both(['a1', 'b2', 'c3', 'd4', 'a1'], ['--max-pages', '2', '--meta']);
    expect(res.code, res.stderr).toBe(0);
    const rows = rowsOf(res);
    expect(rows.map((r) => [r.input, ns(r.result?.installs), r.result?.pages_fetched, r.result?.truncated_reason])).toEqual([
      ['a1', range(4), 2, 'max_pages'],
      ['b2', [0], 1, undefined],
      ['c3', range(4), 2, undefined],
      ['d4', range(4), 2, 'max_pages'],
      ['a1', range(4), 2, 'max_pages'],
    ]);
    expect(rows[0]?.result?.truncated).toBe(true);
    // 1 batch + 1 follow-up each for a1, c3 and d4; the repeated a1 is not fetched again.
    expect(server.toolCalls()).toHaveLength(4);
    expect(res.stderr.split('\n').filter((l) => l.startsWith('{"credit_cost"'))).toEqual(['{"credit_cost":4}']);
    expect(summary(res)).toEqual({ calls: 4, rows: 5, row_errors: 0, truncated_rows: 3, credit_cost: 4, calls_without_cost: 0 });
  });

  it('Story 2 (tool error): a tool error on one company page 2 truncates only that row; the rest complete; exit 3', async () => {
    server.handlers.set(
      TOOL,
      batchHandler({
        companies: { a1: 5, b2: 5, c3: 5 },
        special: (args) => ((args.hg_ids as string[])[0] === 'b2' && args.offset === 2 ? toolError : undefined),
      }),
    );
    const res = await both(['a1', 'b2', 'c3']);
    const error = expectError(res, 3, 'tool_error');
    expect(error.details).toMatchObject({ failed_batches: 0, paging_failures: 1, rows_emitted: 3, calls_made: 6 });
    const rows = rowsOf(res);
    expect(rows.map((r) => [r.input, ns(r.result?.installs), r.result?.truncated_reason])).toEqual([
      ['a1', range(5), undefined],
      ['b2', [0, 1], 'tool_error'],
      ['c3', range(5), undefined],
    ]);
    expect(rows[1]?.result).toMatchObject({ truncated: true, pages_fetched: 1 });
  });

  it('Story 2 (fatal): a credit limit on a follow-up stops the run; earlier rows and the paging row print; exit 6', async () => {
    server.handlers.set(
      TOOL,
      batchHandler({
        companies: counts(6),
        special: (args) => ((args.hg_ids as string[])[0] === 'co2' && args.offset === 2 ? CREDIT_LIMIT : undefined),
      }),
    );
    const res = await both(names(6));
    const error = expectError(res, 6, 'credit_limit_exceeded');
    expect(error.details).toMatchObject({ partial_result: true, rows_emitted: 3, calls_made: 2 });
    expect(server.toolCalls()).toHaveLength(2);
    const rows = rowsOf(res);
    expect(rows.map((r) => r.input)).toEqual(['co0', 'co1', 'co2']);
    expect(rows[2]?.result).toMatchObject({ truncated: true, truncated_reason: 'credit_limit_exceeded', pages_fetched: 1 });
    expect(ns(rows[2]?.result?.installs)).toEqual([0, 1]);
  });

  it('Story 2 (fatal, mixed file): batches go out in input order, so the paging row prints even after a domain line', async () => {
    server.handlers.set(
      TOOL,
      batchHandler({
        companies: { 'a.com': 3, co1: 3, 'b.com': 3 },
        special: (args) => (Array.isArray(args.domains) && args.domains[0] === 'b.com' && args.offset === 2 ? CREDIT_LIMIT : undefined),
      }),
    );
    const res = await both(['a.com', 'co1', 'b.com']);
    const error = expectError(res, 6, 'credit_limit_exceeded');
    expect(sentArgs()).toEqual([
      { domains: ['a.com', 'b.com'] },
      { domains: ['a.com'], offset: 2 },
      { hg_ids: ['co1'] },
      { hg_ids: ['co1'], offset: 2 },
      { domains: ['b.com'], offset: 2 },
    ]);
    expect(error.details).toMatchObject({ partial_result: true, rows_emitted: 3, calls_made: 5 });
    const rows = rowsOf(res);
    expect(rows.map((r) => [r.input, ns(r.result?.installs), r.result?.truncated_reason])).toEqual([
      ['a.com', range(3), undefined],
      ['co1', range(3), undefined],
      ['b.com', [0, 1], 'credit_limit_exceeded'],
    ]);
  });

  it('Story 2 (run cap): the cap reached between follow-ups stops the run the same way; exit 13', async () => {
    server.handlers.set(TOOL, batchHandler({ companies: { a1: 5, b2: 5, c3: 5 } }));
    const res = await both(['a1', 'b2', 'c3'], ['--max-credits', '3'], { ...sb.env, HGI_BUDGET_ID: 'ids-pages' });
    const error = expectError(res, 13, 'budget_exceeded');
    expect(error.details).toMatchObject({ partial_result: true, rows_emitted: 2, calls_made: 3, spent: 3, max: 3 });
    expect(error.hint).toMatch(/nothing more was sent/);
    expect(server.toolCalls()).toHaveLength(3);
    const rows = rowsOf(res);
    expect(rows.map((r) => [r.input, ns(r.result?.installs), r.result?.truncated_reason])).toEqual([
      ['a1', range(5), undefined],
      ['b2', [0, 1], 'budget_exceeded'],
    ]);
  });

  describe.skipIf(process.getuid?.() === 0)('when the run cap cannot record the batch call', () => {
    const budgets = () => path.join(sb.configDir, 'budgets');
    afterEach(() => {
      try {
        fs.chmodSync(budgets(), 0o700);
      } catch {
        // never created
      }
    });

    it('sends no follow-up: page-1 rows, unfinished ones truncated, exit 12 tool_ran with partial_result', async () => {
      server.handlers.set(
        TOOL,
        batchHandler({
          companies: { a1: 5, b2: 1 },
          special: () => {
            fs.chmodSync(budgets(), 0o500);
            return undefined;
          },
        }),
      );
      const res = await both(['a1', 'b2'], ['--max-credits', '50'], { ...sb.env, HGI_BUDGET_ID: 'ids-write' });
      const error = expectError(res, 12, 'local_state_error');
      expect(error.details).toMatchObject({ kind: 'budget_write_failed', tool_ran: true, partial_result: true, rows_emitted: 2, calls_made: 1 });
      expect(server.toolCalls()).toHaveLength(1);
      const rows = rowsOf(res);
      expect(rows.map((r) => [r.input, ns(r.result?.installs), r.result?.pages_fetched, r.result?.truncated_reason])).toEqual([
        ['a1', [0, 1], 1, 'local_state_error'],
        ['b2', [0], 1, undefined],
      ]);
    });
  });
});

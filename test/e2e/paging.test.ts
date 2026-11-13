import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeSandbox, runCli, type CliResult, type Sandbox } from '../support/cli.js';
import { errorBody, login, seedServer } from '../support/e2e.js';
import { FakeServer, textResult } from '../support/fake-server.js';
import {
  BATCH_TOOL,
  CREDIT_LIMIT,
  HAS_MORE_TOOL,
  PAGE_NUMBER_TOOL,
  SPEND_LIKE_TOOL,
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

  it('--all-pages with --ids is refused', async () => {
    const ids = path.join(sb.dir, 'ids.txt');
    fs.writeFileSync(ids, 'a1\nb2\n');
    const error = expectError(await runCli(['call', 'company_widgets', '--all-pages', '--ids', `@${ids}`], sb.env), 2, 'invalid_input');
    expect(error.details?.reason).toBe('all_pages_with_ids');
    expect(server.toolCalls()).toEqual([]);
  });
});

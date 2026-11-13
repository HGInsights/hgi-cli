import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pageSizeOf, pagingSpec, stopReason, type PageState, type PagingSpec } from '../../src/mcp/paging.js';
import type { McpTool } from '../../src/mcp/tools.js';

const snapshot = JSON.parse(fs.readFileSync('test/fixtures/tools-list-2026-11-11.json', 'utf8')) as { tools: McpTool[] };

function tool(output: Record<string, unknown> | undefined, input: Record<string, unknown> = { offset: { type: 'integer' } }): McpTool {
  return {
    name: 't',
    inputSchema: { type: 'object', properties: input },
    ...(output ? { outputSchema: { type: 'object', properties: output } } : {}),
  };
}

const rowsOf = (props: Record<string, unknown> = {}) => ({ type: 'array', items: { type: 'object', properties: props } });

describe('pagingSpec over the live tool-list snapshot', () => {
  const specs = new Map(snapshot.tools.map((t) => [t.name, pagingSpec(t)] as const));
  const pageable = [...specs].filter(([, s]) => s !== null).map(([n]) => n).sort();

  it('finds exactly the offset-paged tools with rows and a stop signal', () => {
    expect(pageable).toEqual(
      ['company_contracts', 'company_fai', 'company_technographic', 'get_vendor_information', 'search_companies', 'search_federal_contracts', 'search_gov_opportunities'].sort(),
    );
  });

  it('reads batch tools per company, with the row-count total (not the money total)', () => {
    expect(specs.get('company_technographic')).toEqual<PagingSpec>({
      kind: 'items',
      itemsKey: 'companies',
      rowsKey: 'installs',
      hasMoreKey: 'has_more',
      totalKey: 'total_installs_count',
      pageSizeKey: 'max_results',
      pageSizeDefault: 50,
    });
    expect(specs.get('company_contracts')).toMatchObject({ kind: 'items', itemsKey: 'companies', rowsKey: 'contracts', hasMoreKey: 'has_more', totalKey: 'total_matching_contracts', pageSizeKey: 'limit' });
  });

  it('reads top-level tools with their own stop signals', () => {
    expect(specs.get('search_companies')).toMatchObject({ kind: 'top', rowsKey: 'companies', totalKey: 'total_count', pageSizeKey: 'limit' });
    expect(specs.get('search_companies')?.hasMoreKey).toBeUndefined();
    expect(specs.get('company_fai')).toMatchObject({ kind: 'top', rowsKey: 'data', totalKey: 'total_count' });
    expect(specs.get('get_vendor_information')).toMatchObject({ kind: 'top', rowsKey: 'vendors', totalKey: 'total', hasMoreKey: 'has_more', pageSizeDefault: 10 });
    expect(specs.get('search_federal_contracts')).toMatchObject({ kind: 'top', rowsKey: 'contracts', totalKey: 'totalCount', hasMoreKey: 'hasMore' });
    expect(specs.get('search_gov_opportunities')).toMatchObject({ kind: 'top', rowsKey: 'opportunities', totalKey: 'totalCount', hasMoreKey: 'hasMore', pageSizeDefault: 25 });
  });

  it('names no tool anywhere in src/', () => {
    const names = snapshot.tools.map((t) => t.name);
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return p === path.join('src', 'generated') ? [] : walk(p);
        return p.endsWith('.ts') ? [p] : [];
      });
    for (const file of walk('src')) {
      const text = fs.readFileSync(file, 'utf8');
      for (const name of names) expect(text.includes(name), `${name} in ${file}`).toBe(false);
    }
  });
});

describe('pagingSpec edge schemas', () => {
  it('needs an integer offset input', () => {
    const out = { rows: rowsOf(), has_more: { type: 'boolean' } };
    expect(pagingSpec(tool(out))).not.toBeNull();
    expect(pagingSpec(tool(out, { offset: { type: 'number' } }))).toBeNull();
    expect(pagingSpec(tool(out, { page: { type: 'integer' } }))).toBeNull();
    expect(pagingSpec(tool(out, { offset: { type: ['integer', 'null'] } }))).not.toBeNull();
    expect(pagingSpec(tool(undefined))).toBeNull();
  });

  it('never takes count as a total', () => {
    expect(pagingSpec(tool({ rows: rowsOf(), count: { type: 'number' } }))).toBeNull();
  });

  it('two total_* candidates mean no total; has_more still makes it pageable', () => {
    const out = { installs: rowsOf(), total_installs_count: { type: 'number' }, total_installs_seen: { type: 'integer' } };
    expect(pagingSpec(tool(out))).toBeNull();
    expect(pagingSpec(tool({ ...out, has_more: { type: 'boolean' } }))).toEqual({ kind: 'top', rowsKey: 'installs', hasMoreKey: 'has_more' });
  });

  it('matches the rows name as a whole segment only, and needs a numeric total', () => {
    expect(pagingSpec(tool({ contracts: rowsOf(), total_contract_value_amount: { type: 'number' } }))).toBeNull();
    expect(pagingSpec(tool({ contracts: rowsOf(), total_matching_contracts: { type: 'string' } }))).toBeNull();
    expect(pagingSpec(tool({ contracts: rowsOf(), total: { type: 'string' }, total_matching_contracts: { type: 'number' } }))?.totalKey).toBe('total_matching_contracts');
  });

  it('ignores stop signals nested under another object', () => {
    expect(pagingSpec(tool({ results: rowsOf(), pagination: { type: 'object', properties: { total: { type: 'number' }, has_more: { type: 'boolean' } } } }))).toBeNull();
  });

  it('needs exactly one rows array per page object', () => {
    expect(pagingSpec(tool({ a: rowsOf(), b: rowsOf(), total: { type: 'number' } }))).toBeNull();
  });

  it('page objects inside a top-level array: one such array only', () => {
    const company = { type: 'array', items: { type: 'object', properties: { installs: rowsOf(), has_more: { type: 'boolean' } } } };
    expect(pagingSpec(tool({ companies: company }))).toMatchObject({ kind: 'items', itemsKey: 'companies', rowsKey: 'installs' });
    expect(pagingSpec(tool({ companies: company, others: company }))).toBeNull();
    // A per-company spend object without rows (company_spend's shape) is not pageable.
    expect(pagingSpec(tool({ companies: rowsOf({ spend: { type: 'object' } }) }))).toBeNull();
  });

  it('page size: one of limit/max_results; both declared means unknown', () => {
    const out = { rows: rowsOf(), has_more: { type: 'boolean' } };
    const both = pagingSpec(tool(out, { offset: { type: 'integer' }, limit: { type: 'integer', default: 5 }, max_results: { type: 'integer' } })) as PagingSpec;
    expect(both.pageSizeKey).toBeUndefined();
    expect(pageSizeOf(both, { limit: 5 })).toBeUndefined();
    const lim = pagingSpec(tool(out, { offset: { type: 'integer' }, limit: { type: 'integer', default: 5 } })) as PagingSpec;
    expect(pageSizeOf(lim, {})).toBe(5);
    expect(pageSizeOf(lim, { limit: 3 })).toBe(3);
    expect(pageSizeOf(lim, { limit: 0 })).toBe(5);
    expect(pageSizeOf(lim, { limit: '3' })).toBe(5);
    const noDefault = pagingSpec(tool(out, { offset: { type: 'integer' }, limit: { type: 'integer' } })) as PagingSpec;
    expect(pageSizeOf(noDefault, {})).toBeUndefined();
  });
});

describe('stopReason', () => {
  const base: PageState = { pageRows: 10, collected: 20, pages: 2, hasMore: true, total: 100 };
  it.each<[string, Partial<PageState>, number | undefined, ReturnType<typeof stopReason>]>([
    ['has_more false', { hasMore: false }, 10, 'done'],
    ['empty page', { pageRows: 0 }, 10, 'done'],
    ['short page despite has_more true', { pageRows: 9 }, 10, 'done'],
    ['total reached despite has_more true', { collected: 100 }, 10, 'done'],
    ['total reached at an exact page boundary', { collected: 20, total: 20 }, 10, 'done'],
    ['max pages', { pages: 3 }, 10, 'max_pages'],
    ['full page, under total, has_more true', {}, 10, null],
    ['no page size, no total, has_more missing', { hasMore: undefined, total: undefined }, undefined, null],
    ['non-numeric total is ignored', { total: '20', collected: 20 }, 10, null],
  ])('%s', (_name, patch, pageSize, expected) => {
    expect(stopReason({ ...base, ...patch }, pageSize, 3)).toBe(expected);
  });
});

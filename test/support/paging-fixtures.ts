import { normalizeId } from '../../src/batch/ids.js';
import type { FakeTool, ToolResult } from './fake-server.js';
import { textResult } from './fake-server.js';

/** Fake paged tools for `hgi call --all-pages`, shaped like the live server's (no live tool names). */

const rowsSchema = { type: 'array', items: { type: 'object', properties: { n: { type: 'number' } } } };

/** Top level page object: `widgets`, `has_more`, `total`; page size `limit` (default 3). */
export const TOP_TOOL: FakeTool = {
  name: 'list_widgets',
  inputSchema: {
    type: 'object',
    properties: { q: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, default: 3 } },
  },
  outputSchema: { type: 'object', properties: { widgets: rowsSchema, has_more: { type: 'boolean' }, total: { type: 'number' }, note: { type: 'string' } } },
  annotations: { readOnlyHint: true },
};

/** `hasMore` only: no total, no page-size input, so only has_more false or an empty page stops it. */
export const HAS_MORE_TOOL: FakeTool = {
  name: 'list_events',
  inputSchema: { type: 'object', properties: { offset: { type: 'integer' } } },
  outputSchema: { type: 'object', properties: { events: rowsSchema, hasMore: { type: 'boolean' } } },
  annotations: { readOnlyHint: true },
};

/** Batch: page objects are `companies[]` items, rows `installs`, page size `max_results` (default 2). */
export const BATCH_TOOL: FakeTool = {
  name: 'company_widgets',
  inputSchema: {
    type: 'object',
    properties: {
      hg_ids: { type: 'array', items: { type: 'string' } },
      domains: { type: 'array', items: { type: 'string' } },
      vendor: { type: 'string' },
      offset: { type: 'integer', minimum: 0 },
      max_results: { type: 'integer', minimum: 1, default: 2 },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      companies: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            company_id: { type: 'string' },
            company_domain: { type: 'string' },
            installs: rowsSchema,
            installs_count: { type: 'number' },
            total_installs_count: { type: 'number' },
            has_more: { type: 'boolean' },
          },
        },
      },
    },
  },
  annotations: { readOnlyHint: true },
};

/** Offset, but no rows array per company (a spend-style tool). */
export const SPEND_LIKE_TOOL: FakeTool = {
  name: 'company_outlay',
  inputSchema: { type: 'object', properties: { hg_ids: { type: 'array', items: { type: 'string' } }, offset: { type: 'integer' } } },
  outputSchema: { type: 'object', properties: { companies: { type: 'array', items: { type: 'object', properties: { company_id: { type: 'string' }, spend: { type: 'object' } } } } } },
  annotations: { readOnlyHint: true },
};

/** Paged by `page`, not `offset` (a contact-search-style tool). */
export const PAGE_NUMBER_TOOL: FakeTool = {
  name: 'people_search',
  inputSchema: { type: 'object', properties: { page: { type: 'integer', minimum: 1 } } },
  outputSchema: { type: 'object', properties: { people: rowsSchema, pagination: { type: 'object' } } },
  annotations: { readOnlyHint: true },
};

export const CREDIT_LIMIT: ToolResult = {
  content: [{ type: 'text', text: 'Credit limit reached for your organization.' }],
  isError: true,
  _meta: { errorCode: 'credit_limit_exceeded' },
};

const rows = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ n: from + i }));

export interface TopOptions {
  rows: number;
  /** The total the server reports; default the real row count. null leaves it out. */
  total?: number | null;
  /** has_more on every page; default: whether rows remain. */
  hasMore?: boolean;
  cost?: number | null;
  /** Calls (1-based) that get a special answer instead. */
  special?: Record<number, ToolResult>;
  delayMs?: number;
}

/** Answers `list_widgets` by slicing `rows` by `offset` and `limit`. */
export function topHandler(opts: TopOptions): (args: Record<string, unknown>) => Promise<ToolResult> {
  let call = 0;
  return async (args) => {
    call += 1;
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const special = opts.special?.[call];
    if (special) return special;
    const offset = typeof args.offset === 'number' ? args.offset : 0;
    const limit = typeof args.limit === 'number' ? args.limit : 3;
    const count = Math.max(0, Math.min(limit, opts.rows - offset));
    const total = opts.total === undefined ? opts.rows : opts.total;
    return textResult(
      {
        widgets: rows(offset, count),
        has_more: opts.hasMore ?? offset + count < opts.rows,
        ...(total === null ? {} : { total }),
        note: `page at ${offset}`,
      },
      opts.cost === undefined ? 1 : opts.cost,
    );
  };
}

export interface BatchOptions {
  /** Rows per company, keyed by the id as the caller sends it. */
  companies: Record<string, number>;
  /** Answer with ids lowercased and leading zeros dropped. */
  dropLeadingZeros?: boolean;
  /** Extra entries on page 1 (e.g. one matching no input). */
  extra?: Array<Record<string, unknown>>;
  /** The company answered when the input names none. */
  fallback?: string;
  delayMs?: number;
}

/** Answers `company_widgets`: one entry per requested id, installs sliced by `offset` and `max_results`. */
export function batchHandler(opts: BatchOptions): (args: Record<string, unknown>) => Promise<ToolResult> {
  return async (args) => {
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const offset = typeof args.offset === 'number' ? args.offset : 0;
    const size = typeof args.max_results === 'number' ? args.max_results : 2;
    const ids = Array.isArray(args.hg_ids) ? (args.hg_ids as string[]) : opts.fallback ? [opts.fallback] : [];
    const companies = ids.map((id) => {
      const total = opts.companies[id] ?? 0;
      const count = Math.max(0, Math.min(size, total - offset));
      return {
        company_id: opts.dropLeadingZeros ? normalizeId(id) : id,
        installs: rows(offset, count),
        installs_count: count,
        total_installs_count: total,
        // Wrong on purpose at exact page boundaries, like the live server.
        has_more: offset + count <= total,
      };
    });
    return textResult({ companies: [...companies, ...(offset === 0 ? (opts.extra ?? []) : [])] }, 1);
  };
}

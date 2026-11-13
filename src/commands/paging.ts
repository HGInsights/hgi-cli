import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { normalizeDomain, normalizeId, type IdKind } from '../batch/ids.js';
import { DOMAIN_MATCH_KEY, ID_MATCH_KEYS, keyText } from '../batch/plan.js';
import { checkBudget, recordSpend } from '../budget.js';
import { HgiError, toHgiError } from '../errors.js';
import { pageSizeOf, pagingSpec, stopReason, type PagingSpec } from '../mcp/paging.js';
import { creditCostOf, interpretResult } from '../mcp/result.js';
import { isRecord } from '../mcp/schema-shape.js';
import type { McpSession } from '../mcp/session.js';
import type { McpTool } from '../mcp/tools.js';
import { assertValidInput } from '../mcp/validate.js';

/** `--max-pages` when it is not given: counts page 1, per page object. */
export const DEFAULT_MAX_PAGES = 10;

export interface PagingFlags {
  allPages?: boolean;
  maxPages?: string;
  ids?: string;
}

function usage(message: string, reason: string, extra: Record<string, unknown> = {}): HgiError {
  return new HgiError('invalid_input', message, { hint: 'Nothing was sent.', details: { reason, ...extra } });
}

/** Flag checks that need no network. Returns the page cap, or null without `--all-pages`. */
export function preflightPaging(flags: PagingFlags, input: Record<string, unknown>): number | null {
  if (!flags.allPages) {
    if (flags.maxPages !== undefined) throw usage('--max-pages needs --all-pages.', 'max_pages_without_all_pages');
    return null;
  }
  let maxPages = DEFAULT_MAX_PAGES;
  if (flags.maxPages !== undefined) {
    const raw = flags.maxPages.trim();
    const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(n) || n < 1) throw usage(`--max-pages must be a whole number of at least 1, not "${flags.maxPages}".`, 'bad_max_pages');
    maxPages = n;
  }
  if (flags.ids !== undefined) throw usage('--all-pages cannot be combined with --ids yet.', 'all_pages_with_ids');
  if (Object.hasOwn(input, 'offset')) throw usage('--all-pages sets "offset" itself; remove it from --input.', 'offset_with_all_pages');
  return maxPages;
}

/** The tool's paging rule, or exit 2 `not_pageable` before anything is sent. */
export function assertPageable(tool: McpTool): PagingSpec {
  const spec = pagingSpec(tool);
  if (spec) return spec;
  throw new HgiError('invalid_input', `${tool.name} cannot be paged safely with --all-pages.`, {
    hint: 'Its schema has no integer "offset" input, or its output has no single rows array with has_more or a total. Nothing was sent. Page it yourself with --input.',
    details: { reason: 'not_pageable', tool: tool.name },
  });
}

export interface PagingContext {
  session: McpSession;
  tool: McpTool;
  input: Record<string, unknown>;
  spec: PagingSpec;
  maxPages: number;
  validate: boolean;
  /** The run cap: checked before every page after the first, each page's cost recorded after it. */
  budget?: { id: string; max: number };
  /** Called with every result that came back (the credit ledger). Never throws. */
  onResult?: (result: CallToolResult) => Promise<void>;
}

export interface PagedOutcome {
  /** The merged result, in the server's shape. */
  value: unknown;
  /** `tools/call` requests sent, the failed one included. */
  callsMade: number;
  callsWithoutCost: number;
  /** The sum of reported costs, or null when no call reported one. */
  creditCost: number | null;
  /** A failure after page 1. The merged value holds everything before it. */
  failure?: HgiError;
  /**
   * Page 1 ran but its spend could not be recorded under a run cap. `value` is page 1 exactly as the server sent
   * it and `failure` is that budget error: the caller handles it as a single call would.
   */
  pageOneBudgetFailure?: true;
}

interface Tracker {
  entry: Record<string, unknown>;
  /** null when page 1 had no rows array: nothing to merge or page. */
  rows: unknown[] | null;
  pages: number;
  done: boolean;
  reason?: string;
  /** Batch follow-ups: the original input, or one company as the caller gave it. */
  follow?: 'same' | { field: 'hg_ids' | 'domains'; text: string; kind: IdKind; norm: string };
  /** The one company every page of this entry must be (when the input named one), else unchecked. */
  expect?: { kind: IdKind; norm: string };
}

interface Accounting {
  callsMade: number;
  callsWithoutCost: number;
  creditSum: number;
}

/** Stops paging. Carries the error that ends the run; the merged result so far is still printed. */
class StopPaging extends Error {
  /** The merged result up to the stop, set by the loop that caught it. */
  merged: unknown;

  constructor(readonly error: HgiError) {
    super(error.message);
  }
}

function unexpected(tool: McpTool, what: string): HgiError {
  return new HgiError('tool_error', `A later page of ${tool.name} came back without ${what}; paging stopped.`, {
    details: { reason: 'unexpected_response', tool: tool.name },
  });
}

class Pager {
  readonly acc: Accounting = { callsMade: 0, callsWithoutCost: 0, creditSum: 0 };
  private readonly pageSize: number | undefined;

  constructor(private readonly ctx: PagingContext) {
    this.pageSize = pageSizeOf(ctx.spec, ctx.input);
  }

  /**
   * Sends one page. Page 1 was checked against the run cap before the session opened. A page whose spend could
   * not be recorded is returned with `budgetFailure`, so its rows are kept before paging stops.
   */
  async fetch(args: Record<string, unknown>, first: boolean): Promise<{ value: unknown; budgetFailure: HgiError | null }> {
    const { session, tool, budget } = this.ctx;
    if (!first && budget) await checkBudget(budget.id, budget.max);
    if (!first && this.ctx.validate) assertValidInput(tool, args);
    this.acc.callsMade += 1;
    let result: CallToolResult;
    try {
      result = await session.callTool(tool.name, args);
    } catch (err) {
      this.acc.callsWithoutCost += 1;
      throw err;
    }
    const cost = creditCostOf(result);
    if (cost === null) this.acc.callsWithoutCost += 1;
    else this.acc.creditSum += cost;
    await this.ctx.onResult?.(result);
    let budgetFailure: HgiError | null = null;
    if (budget) {
      try {
        await recordSpend(budget.id, budget.max, cost);
      } catch (err) {
        budgetFailure = toHgiError(err);
      }
    }
    try {
      return { value: interpretResult(result, tool.name).value, budgetFailure };
    } catch (err) {
      // A server refusal stays the error the caller acts on; a failed budget write is only flagged on it.
      if (budgetFailure && err instanceof HgiError) {
        throw new HgiError(err.code, err.message, { hint: err.hint, details: { ...err.details, budget_write_failed: true }, cause: err });
      }
      throw err;
    }
  }

  /** A follow-up page: any failure stops paging. */
  async fetchLater(args: Record<string, unknown>): Promise<{ value: unknown; budgetFailure: HgiError | null }> {
    try {
      return await this.fetch(args, false);
    } catch (err) {
      throw new StopPaging(toHgiError(err));
    }
  }

  track(entry: Record<string, unknown>): Tracker {
    const rows = entry[this.ctx.spec.rowsKey];
    const t: Tracker = { entry, rows: Array.isArray(rows) ? [...(rows as unknown[])] : null, pages: 0, done: false };
    this.settle(t, Array.isArray(rows) ? rows.length : 0);
    return t;
  }

  /** Applies the stop rule after a page with `pageRows` rows. */
  settle(t: Tracker, pageRows: number): void {
    t.pages += 1;
    const { hasMoreKey, totalKey } = this.ctx.spec;
    const reason = stopReason(
      {
        pageRows,
        collected: t.rows?.length ?? 0,
        pages: t.pages,
        hasMore: hasMoreKey ? t.entry[hasMoreKey] : undefined,
        total: totalKey ? t.entry[totalKey] : undefined,
      },
      this.pageSize,
      this.ctx.maxPages,
    );
    if (reason === null) return;
    t.done = true;
    if (reason === 'max_pages') t.reason = 'max_pages';
  }

  /** Adds a follow-up page object's rows to its tracker. */
  append(t: Tracker, entry: Record<string, unknown>): void {
    const rows = entry[this.ctx.spec.rowsKey];
    if (!Array.isArray(rows)) throw new StopPaging(unexpected(this.ctx.tool, `a "${this.ctx.spec.rowsKey}" array`));
    t.entry = entry;
    t.rows = [...(t.rows ?? []), ...(rows as unknown[])];
    this.settle(t, rows.length);
  }

  merged(t: Tracker): Record<string, unknown> {
    return {
      ...t.entry,
      ...(t.rows === null ? {} : { [this.ctx.spec.rowsKey]: t.rows }),
      pages_fetched: t.pages,
      ...(t.reason === undefined ? {} : { truncated: true, truncated_reason: t.reason }),
    };
  }

  creditCost(): number | null {
    return this.acc.callsMade > this.acc.callsWithoutCost ? this.acc.creditSum : null;
  }
}

/** Every string in `hg_ids` (ids) and `domains` (domains) of the input, as the caller gave it. */
function companyInputs(input: Record<string, unknown>): Array<{ field: 'hg_ids' | 'domains'; kind: IdKind; text: string; norm: string }> {
  const out: Array<{ field: 'hg_ids' | 'domains'; kind: IdKind; text: string; norm: string }> = [];
  for (const [field, kind] of [['hg_ids', 'id'], ['domains', 'domain']] as const) {
    const values = input[field];
    if (!Array.isArray(values)) continue;
    for (const text of values) {
      if (typeof text === 'string') out.push({ field, kind, text, norm: kind === 'id' ? normalizeId(text) : normalizeDomain(text) });
    }
  }
  return out;
}

function entryKey(entry: Record<string, unknown>, kind: IdKind): string | null {
  if (kind === 'domain') {
    const raw = keyText(entry[DOMAIN_MATCH_KEY]);
    return raw === null ? null : normalizeDomain(raw);
  }
  for (const key of ID_MATCH_KEYS) {
    const raw = keyText(entry[key]);
    if (raw !== null) return normalizeId(raw);
  }
  return null;
}

function matches(entry: Record<string, unknown>, input: { kind: IdKind; norm: string }): boolean {
  return entryKey(entry, input.kind) === input.norm;
}

function withoutCompanies(input: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...input };
  delete rest.hg_ids;
  delete rest.domains;
  return rest;
}

/** Decides how each unfinished batch entry is followed up, or marks it `unmatched`. Never guesses. */
function planFollowUps(trackers: Array<Tracker | null>, input: Record<string, unknown>): void {
  const live = trackers.filter((t): t is Tracker => t !== null);
  const inputs = companyInputs(input);
  if (inputs.length < 2) {
    const named = inputs[0];
    for (const t of live) {
      if (t.done) continue;
      // One entry, and it is the company the input named (when it named one): page with the input as given.
      if (trackers.length === 1 && (named === undefined || matches(t.entry, named))) {
        t.follow = 'same';
        if (named) t.expect = { kind: named.kind, norm: named.norm };
      } else {
        Object.assign(t, { done: true, reason: 'unmatched' });
      }
    }
    return;
  }
  const matchedBy = new Map<number, number>();
  const candidates = live.map((t) => inputs.map((inp, i) => (matches(t.entry, inp) ? i : -1)).filter((i) => i >= 0));
  for (const list of candidates) for (const i of list) matchedBy.set(i, (matchedBy.get(i) ?? 0) + 1);
  live.forEach((t, k) => {
    if (t.done) return;
    const list = candidates[k] as number[];
    const only = list.length === 1 ? (list[0] as number) : -1;
    if (only >= 0 && matchedBy.get(only) === 1) {
      const inp = inputs[only] as (typeof inputs)[number];
      t.follow = { field: inp.field, text: inp.text, kind: inp.kind, norm: inp.norm };
    } else {
      Object.assign(t, { done: true, reason: 'unmatched' });
    }
  });
}

async function pageTop(p: Pager, ctx: PagingContext, first: unknown): Promise<unknown> {
  if (!isRecord(first)) return first;
  const t = p.track(first);
  try {
    while (!t.done) {
      const page = await p.fetchLater({ ...ctx.input, offset: t.rows?.length ?? 0 });
      if (!isRecord(page.value)) throw new StopPaging(unexpected(ctx.tool, 'a result object'));
      p.append(t, page.value);
      if (page.budgetFailure) throw new StopPaging(page.budgetFailure);
    }
  } catch (err) {
    if (!(err instanceof StopPaging)) throw err;
    if (!t.done) Object.assign(t, { done: true, reason: err.error.code });
    err.merged = p.merged(t);
    throw err;
  }
  return p.merged(t);
}

async function pageItems(p: Pager, ctx: PagingContext, first: unknown): Promise<unknown> {
  const itemsKey = ctx.spec.itemsKey as string;
  if (!isRecord(first) || !Array.isArray(first[itemsKey])) return first;
  const entries = first[itemsKey] as unknown[];
  const trackers = entries.map((e) => (isRecord(e) ? p.track(e) : null));
  planFollowUps(trackers, ctx.input);
  const merge = () => ({ ...first, [itemsKey]: entries.map((e, i) => (trackers[i] ? p.merged(trackers[i] as Tracker) : e)) });
  try {
    for (const t of trackers) {
      while (t && !t.done) {
        const follow = t.follow as NonNullable<Tracker['follow']>;
        const args =
          follow === 'same'
            ? { ...ctx.input, offset: t.rows?.length ?? 0 }
            : { ...withoutCompanies(ctx.input), [follow.field]: [follow.text], offset: t.rows?.length ?? 0 };
        const page = await p.fetchLater(args);
        if (!isRecord(page.value) || !Array.isArray(page.value[itemsKey])) {
          throw new StopPaging(unexpected(ctx.tool, `a "${itemsKey}" array`));
        }
        const list = page.value[itemsKey] as unknown[];
        const only = list.length === 1 && isRecord(list[0]) ? list[0] : null;
        const want = follow === 'same' ? t.expect : follow;
        if (only === null || (want !== undefined && !matches(only, want))) {
          Object.assign(t, { done: true, reason: 'unmatched' });
        } else {
          p.append(t, only);
        }
        if (page.budgetFailure) throw new StopPaging(page.budgetFailure);
      }
    }
  } catch (err) {
    if (!(err instanceof StopPaging)) throw err;
    for (const t of trackers) if (t && !t.done) Object.assign(t, { done: true, reason: err.error.code });
    err.merged = merge();
    throw err;
  }
  return merge();
}

/**
 * Fetches every page, one at a time, and merges them. A failure on page 1 is thrown exactly as a single call's;
 * a failure after it is returned in `failure`, with the merged result so far. Never retries a sent call.
 */
export async function runAllPages(ctx: PagingContext): Promise<PagedOutcome> {
  const p = new Pager(ctx);
  const first = await p.fetch(ctx.input, true);
  const outcome = (value: unknown, failure?: HgiError): PagedOutcome => ({
    value,
    callsMade: p.acc.callsMade,
    callsWithoutCost: p.acc.callsWithoutCost,
    creditCost: p.creditCost(),
    ...(failure ? { failure } : {}),
  });
  if (first.budgetFailure) {
    // Exactly what `hgi call` does without --all-pages: page 1 as sent, then exit 12 `budget_write_failed`.
    return { ...outcome(first.value, first.budgetFailure), pageOneBudgetFailure: true };
  }
  try {
    return outcome(ctx.spec.kind === 'top' ? await pageTop(p, ctx, first.value) : await pageItems(p, ctx, first.value));
  } catch (err) {
    if (err instanceof StopPaging) return outcome(err.merged, err.error);
    throw err;
  }
}

import { hasType, isArrayOfObjects, isRecord, propertiesOf } from './schema-shape.js';
import type { McpTool } from './tools.js';

/**
 * Which tools `hgi call --all-pages` can page, read from the tool's schemas only, never from its name.
 * See docs/output-formats.md → `hgi call --all-pages`.
 */

/** One page object: the rows it holds and the signals that say when it is complete. */
export interface PageObjectSpec {
  rowsKey: string;
  hasMoreKey?: 'has_more' | 'hasMore';
  totalKey?: string;
}

export interface PagingSpec extends PageObjectSpec {
  /** `top`: the result itself is the page object. `items`: each item of `itemsKey` is one (batch tools). */
  kind: 'top' | 'items';
  itemsKey?: string;
  pageSizeKey?: 'limit' | 'max_results';
  /** The schema `default` of `pageSizeKey`, when it is a positive whole number. */
  pageSizeDefault?: number;
}

const NAMED_TOTALS = ['total', 'total_count', 'totalCount'] as const;
const PAGE_SIZE_KEYS = ['limit', 'max_results'] as const;

function isNumeric(schema: unknown): boolean {
  return isRecord(schema) && (hasType(schema, 'integer') || hasType(schema, 'number'));
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/**
 * The total for a page object whose rows are `rowsKey`: `total`, `total_count` or `totalCount` if one exists,
 * otherwise the single numeric `total_*` property with `rowsKey` as a whole `_`-separated segment of its name.
 * `count` is never a total: it can be the size of this page.
 */
function totalKeyOf(props: Record<string, unknown>, rowsKey: string): string | undefined {
  for (const key of NAMED_TOTALS) {
    if (Object.hasOwn(props, key) && isNumeric(props[key])) return key;
  }
  const candidates = Object.keys(props).filter(
    (key) => key.startsWith('total_') && isNumeric(props[key]) && key.split('_').includes(rowsKey),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** A page object: exactly one array-of-objects property (its rows), plus `has_more`/`hasMore`, a total, or both. */
export function pageObjectSpec(schema: unknown): PageObjectSpec | null {
  const props = propertiesOf(schema);
  const arrays = Object.keys(props).filter((key) => isArrayOfObjects(props[key]));
  if (arrays.length !== 1) return null;
  const rowsKey = arrays[0] as string;
  const hasMoreKey = Object.hasOwn(props, 'has_more') ? 'has_more' : Object.hasOwn(props, 'hasMore') ? 'hasMore' : undefined;
  const totalKey = totalKeyOf(props, rowsKey);
  if (hasMoreKey === undefined && totalKey === undefined) return null;
  return { rowsKey, ...(hasMoreKey ? { hasMoreKey } : {}), ...(totalKey ? { totalKey } : {}) };
}

function pageSizeOfSchema(inputProps: Record<string, unknown>): Pick<PagingSpec, 'pageSizeKey' | 'pageSizeDefault'> {
  const declared = PAGE_SIZE_KEYS.filter((key) => Object.hasOwn(inputProps, key));
  // Both declared: which one the server honours is unknown, so the page size is unknown.
  if (declared.length !== 1) return {};
  const key = declared[0] as PagingSpec['pageSizeKey'] & string;
  const schema = inputProps[key];
  const fallback = isRecord(schema) ? schema.default : undefined;
  return { pageSizeKey: key, ...(isPositiveInt(fallback) ? { pageSizeDefault: fallback } : {}) };
}

/** How to page `tool`, or null when it cannot be paged safely. */
export function pagingSpec(tool: McpTool): PagingSpec | null {
  const inputProps = propertiesOf(tool.inputSchema);
  const offset = inputProps.offset;
  if (!isRecord(offset) || !hasType(offset, 'integer')) return null;
  if (!isRecord(tool.outputSchema)) return null;
  const size = pageSizeOfSchema(inputProps);

  const top = pageObjectSpec(tool.outputSchema);
  if (top) return { kind: 'top', ...top, ...size };

  const outputProps = propertiesOf(tool.outputSchema);
  const itemSpecs = Object.keys(outputProps)
    .filter((key) => isArrayOfObjects(outputProps[key]))
    .map((key) => ({ key, spec: pageObjectSpec((outputProps[key] as Record<string, unknown>).items) }))
    .filter((c): c is { key: string; spec: PageObjectSpec } => c.spec !== null);
  if (itemSpecs.length !== 1) return null;
  const only = itemSpecs[0] as { key: string; spec: PageObjectSpec };
  return { kind: 'items', itemsKey: only.key, ...only.spec, ...size };
}

/** The page size: the `limit`/`max_results` value sent in the input, else its schema default, else unknown. */
export function pageSizeOf(spec: PagingSpec, input: Record<string, unknown>): number | undefined {
  if (spec.pageSizeKey === undefined) return undefined;
  const sent = input[spec.pageSizeKey];
  if (isPositiveInt(sent)) return sent;
  return spec.pageSizeDefault;
}

export type StopReason = 'done' | 'max_pages';

export interface PageState {
  /** Rows on the page just fetched. */
  pageRows: number;
  /** Rows collected so far for this page object, this page included. */
  collected: number;
  /** Pages fetched so far for this page object, this page included. */
  pages: number;
  hasMore: unknown;
  total: unknown;
}

/**
 * The stop rule, per page object, after each page. `has_more: true` alone never keeps paging past a short page,
 * an empty page or the total. null means: fetch the next page at `offset = collected`.
 */
export function stopReason(state: PageState, pageSize: number | undefined, maxPages: number): StopReason | null {
  if (state.hasMore === false) return 'done';
  if (state.pageRows === 0) return 'done';
  if (pageSize !== undefined && state.pageRows < pageSize) return 'done';
  if (typeof state.total === 'number' && Number.isFinite(state.total) && state.collected >= state.total) return 'done';
  if (state.pages >= maxPages) return 'max_pages';
  return null;
}

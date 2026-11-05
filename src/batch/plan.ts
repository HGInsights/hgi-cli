import { HgiError } from '../errors.js';
import type { McpTool } from '../mcp/tools.js';
import { classify, normalize, type IdKind, type IdLine } from './ids.js';

const DEFAULT_BATCH_SIZE = 25;

/** The batch fields hgi knows, by kind. Read from the input schema, never from the tool name. */
const FIELD_FOR: Record<IdKind, 'hg_ids' | 'domains'> = { id: 'hg_ids', domain: 'domains' };

/**
 * The keys an entry is matched on, in order. Fixed on purpose: entries carry other `*_id` fields (parent ids), and
 * deriving keys from the schema could silently mis-join rows.
 */
const ID_MATCH_KEYS = ['company_id', 'requested_hg_id', 'organization_id'] as const;
const DOMAIN_MATCH_KEY = 'company_domain';

export interface BatchField {
  field: 'hg_ids' | 'domains';
  /** `maxItems`, or 25 when absent; null when the schema declares an unusable `maxItems`. */
  max: number | null;
  declaredMax?: unknown;
}

export type BatchFields = Partial<Record<IdKind, BatchField>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasType(schema: Record<string, unknown>, type: string): boolean {
  return schema.type === type || (Array.isArray(schema.type) && schema.type.includes(type));
}

export function batchFields(tool: McpTool): BatchFields {
  const props = isRecord(tool.inputSchema.properties) ? tool.inputSchema.properties : {};
  const fields: BatchFields = {};
  for (const kind of ['id', 'domain'] as const) {
    const name = FIELD_FOR[kind];
    const schema = props[name];
    if (!isRecord(schema) || !hasType(schema, 'array')) continue;
    if (!('maxItems' in schema)) {
      fields[kind] = { field: name, max: DEFAULT_BATCH_SIZE };
      continue;
    }
    const declared = schema.maxItems;
    const usable = typeof declared === 'number' && Number.isInteger(declared) && declared >= 1;
    fields[kind] = usable ? { field: name, max: declared } : { field: name, max: null, declaredMax: declared };
  }
  return fields;
}

/** The output schema's single top-level array-of-objects property, else `companies`. */
export function entriesKey(tool: McpTool): string {
  const props = isRecord(tool.outputSchema?.properties) ? tool.outputSchema.properties : {};
  const candidates = Object.entries(props).filter(([, schema]) => {
    if (!isRecord(schema) || !hasType(schema, 'array')) return false;
    const items = schema.items;
    return isRecord(items) && (hasType(items, 'object') || isRecord(items.properties));
  });
  return candidates.length === 1 ? (candidates[0] as [string, unknown])[0] : 'companies';
}

export interface UniqueInput {
  kind: IdKind;
  /** The first occurrence's trimmed text; this is what is sent. */
  text: string;
  norm: string;
}

export interface Batch {
  kind: IdKind;
  field: 'hg_ids' | 'domains';
  items: UniqueInput[];
}

export interface BatchPlan {
  batches: Batch[];
  /** For every input line, in order: the line and its unique input. */
  lines: Array<{ text: string; unique: UniqueInput }>;
}

export function buildBatches(input: IdLine[], fields: BatchFields, batchSize?: number): BatchPlan {
  const uniques = new Map<string, UniqueInput & { first: number }>();
  const lines: BatchPlan['lines'] = [];
  input.forEach((line, position) => {
    const kind = classify(line.text);
    const field = fields[kind];
    if (!field) {
      const has = Object.values(fields).map((f) => f.field);
      throw new HgiError('invalid_input', `Line ${line.line} is ${kind === 'domain' ? 'a domain' : 'an HG id'}, but this tool has no "${FIELD_FOR[kind]}" field.`, {
        hint: has.length ? `This tool takes: ${has.join(', ')}. Nothing was sent.` : 'This tool takes neither hg_ids nor domains. Nothing was sent.',
        details: { reason: 'unsupported_kind', kind, line: line.line, fields: has },
      });
    }
    const norm = normalize(kind, line.text);
    const key = `${kind}:${norm}`;
    let unique = uniques.get(key);
    if (!unique) {
      unique = { kind, text: line.text, norm, first: position };
      uniques.set(key, unique);
    }
    lines.push({ text: line.text, unique });
  });

  const chunks: Batch[] = [];
  for (const kind of ['id', 'domain'] as const) {
    const field = fields[kind];
    const ofKind = [...uniques.values()].filter((u) => u.kind === kind);
    if (!field || ofKind.length === 0) continue;
    const max = usableMax(field);
    if (batchSize !== undefined && batchSize > max) {
      throw new HgiError('invalid_input', `--batch-size ${batchSize} is above the tool's limit of ${max} for "${field.field}".`, {
        hint: '--batch-size can only lower the batch size. Nothing was sent.',
        details: { reason: 'bad_batch_size', field: field.field, max },
      });
    }
    const size = batchSize ?? max;
    for (let i = 0; i < ofKind.length; i += size) {
      chunks.push({ kind, field: field.field, items: ofKind.slice(i, i + size) });
    }
  }
  const firstOf = (b: Batch) => (b.items[0] as UniqueInput & { first: number }).first;
  chunks.sort((a, b) => firstOf(a) - firstOf(b));
  return { batches: chunks, lines };
}

function usableMax(field: BatchField): number {
  if (field.max !== null) return field.max;
  throw new HgiError('invalid_input', `The tool declares an unusable maxItems for "${field.field}", so --ids cannot batch it.`, {
    hint: 'Nothing was sent. Call the tool with --input instead.',
    details: { reason: 'unusable_max_items', field: field.field, max_items: field.declaredMax ?? null },
  });
}

function keyText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Indexes a batch response's entries by normalised match key. Returns null when the response has no array under
 * `key` (an unexpected response).
 */
export function matchEntries(kind: IdKind, value: unknown, key: string): Map<string, Record<string, unknown>> | null {
  if (!isRecord(value) || !Array.isArray(value[key])) return null;
  const index = new Map<string, Record<string, unknown>>();
  for (const entry of value[key] as unknown[]) {
    if (!isRecord(entry)) continue;
    let raw: string | null = null;
    if (kind === 'id') {
      for (const k of ID_MATCH_KEYS) {
        raw = keyText(entry[k]);
        if (raw !== null) break;
      }
    } else {
      raw = keyText(entry[DOMAIN_MATCH_KEY]);
    }
    if (raw === null) continue;
    const norm = normalize(kind, raw);
    if (!index.has(norm)) index.set(norm, entry);
  }
  return index;
}

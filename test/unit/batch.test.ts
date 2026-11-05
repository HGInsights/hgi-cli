import { describe, expect, it } from 'vitest';
import { HgiError } from '../../src/errors.js';
import { classify, normalizeDomain, normalizeId, parseCsv, parseCsvColumn, parseIdLines } from '../../src/batch/ids.js';
import { batchFields, buildBatches, entriesKey, matchEntries } from '../../src/batch/plan.js';
import type { McpTool } from '../../src/mcp/tools.js';

function reasonOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HgiError);
    return (err as HgiError).details?.reason;
  }
  throw new Error('expected a throw');
}

const tool = (props: Record<string, unknown>, outputSchema?: Record<string, unknown>): McpTool => ({
  name: 'batchy',
  inputSchema: { type: 'object', properties: props },
  ...(outputSchema ? { outputSchema } : {}),
});

describe('normalisation and classification', () => {
  it('ids are lowercased with leading zeros stripped', () => {
    expect(normalizeId('00ABC123')).toBe('abc123');
    expect(normalizeId('abc123')).toBe('abc123');
    expect(normalizeId('000')).toBe('0');
  });
  it('domains drop scheme, www., path, query and fragment and are lowercased', () => {
    expect(normalizeDomain('https://www.Example.com/about')).toBe('example.com');
    expect(normalizeDomain('HTTP://example.com?x=1')).toBe('example.com');
    expect(normalizeDomain('www.example.com#top')).toBe('example.com');
    expect(normalizeDomain('sub.example.com')).toBe('sub.example.com');
  });
  it('a line with a dot is a domain, otherwise an HG id', () => {
    expect(classify('example.com')).toBe('domain');
    expect(classify('0abc123')).toBe('id');
  });
});

describe('parseIdLines', () => {
  it('trims whitespace and \\r and skips blanks and # comments', () => {
    const text = '﻿# header\r\n  a1 \r\n\r\n#skip\nb2\n   \n';
    expect(parseIdLines(text)).toEqual([
      { text: 'a1', line: 2 },
      { text: 'b2', line: 5 },
    ]);
  });
});

describe('CSV column reader', () => {
  it('parses quoted fields with embedded commas, quotes and newlines (CRLF and LF)', () => {
    const csv = 'name,hg_id\r\n"Acme, Inc.",a1\r\n"Say ""hi""",b2\n"multi\nline",c3\n';
    expect(parseCsv(csv)).toEqual([
      ['name', 'hg_id'],
      ['Acme, Inc.', 'a1'],
      ['Say "hi"', 'b2'],
      ['multi\nline', 'c3'],
    ]);
  });
  it('reads one column by header name, skipping empty cells', () => {
    const csv = '﻿name, hg_id \n"x",a1\ny,\nz," b2 "';
    expect(parseCsvColumn(csv, 'hg_id').map((l) => l.text)).toEqual(['a1', 'b2']);
  });
  it('an unknown column is unknown_column; an unclosed quote is bad_csv', () => {
    expect(reasonOf(() => parseCsvColumn('a,b\n1,2\n', 'hg_id'))).toBe('unknown_column');
    expect(reasonOf(() => parseCsvColumn('hg_id\n"a1\n', 'hg_id'))).toBe('bad_csv');
  });
});

describe('batchFields and entriesKey', () => {
  it('reads hg_ids/domains array fields with maxItems, defaulting to 25', () => {
    const fields = batchFields(tool({ hg_ids: { type: 'array', maxItems: 10 }, domains: { type: ['array', 'null'] }, x: { type: 'string' } }));
    expect(fields).toEqual({ id: { field: 'hg_ids', max: 10 }, domain: { field: 'domains', max: 25 } });
  });
  it('ignores non-array fields of those names', () => {
    expect(batchFields(tool({ hg_ids: { type: 'string' } }))).toEqual({});
  });
  it('an unusable maxItems is refused when that field is used', () => {
    for (const maxItems of [0, -1, 2.5, 'x', null]) {
      const fields = batchFields(tool({ hg_ids: { type: 'array', maxItems } }));
      expect(reasonOf(() => buildBatches([{ text: 'a1', line: 1 }], fields))).toBe('unusable_max_items');
    }
  });
  it('uses the single array-of-objects output property, else companies', () => {
    const out = { type: 'object', properties: { results: { type: 'array', items: { type: 'object' } }, not_found: { type: 'array', items: { type: 'string' } } } };
    expect(entriesKey(tool({}, out))).toBe('results');
    expect(entriesKey(tool({}))).toBe('companies');
    const two = { type: 'object', properties: { a: { type: 'array', items: { type: 'object' } }, b: { type: 'array', items: { type: 'object' } } } };
    expect(entriesKey(tool({}, two))).toBe('companies');
  });
});

describe('buildBatches', () => {
  const fields = { id: { field: 'hg_ids' as const, max: 2 }, domain: { field: 'domains' as const, max: 2 } };
  const lines = (...texts: string[]) => texts.map((text, i) => ({ text, line: i + 1 }));

  it('de-duplicates by normalised form, keeps first text, chunks in first-appearance order', () => {
    const plan = buildBatches(lines('0a1', 'b2', 'A1', 'c3', 'd4'), fields);
    expect(plan.batches.map((b) => b.items.map((u) => u.text))).toEqual([['0a1', 'b2'], ['c3', 'd4']]);
    expect(plan.lines.map((l) => [l.text, l.unique.text])).toEqual([
      ['0a1', '0a1'],
      ['b2', 'b2'],
      ['A1', '0a1'],
      ['c3', 'c3'],
      ['d4', 'd4'],
    ]);
  });
  it('separates ids and domains and orders batches by their first input', () => {
    const plan = buildBatches(lines('x.com', 'a1', 'y.com', 'z.com', 'b2'), fields);
    expect(plan.batches.map((b) => [b.field, b.items.map((u) => u.text)])).toEqual([
      ['domains', ['x.com', 'y.com']],
      ['hg_ids', ['a1', 'b2']],
      ['domains', ['z.com']],
    ]);
  });
  it('--batch-size lowers the size and may not exceed the limit', () => {
    expect(buildBatches(lines('a1', 'b2', 'c3'), fields, 1).batches).toHaveLength(3);
    expect(reasonOf(() => buildBatches(lines('a1'), fields, 3))).toBe('bad_batch_size');
  });
  it('a kind the tool has no field for is unsupported_kind', () => {
    expect(reasonOf(() => buildBatches(lines('a1', 'x.com'), { id: fields.id }))).toBe('unsupported_kind');
  });
});

describe('matchEntries', () => {
  it('matches ids on company_id, else requested_hg_id, else organization_id, with leading zeros dropped', () => {
    const index = matchEntries('id', {
      companies: [
        { company_id: 'ABC', parent_id: 'zzz' },
        { requested_hg_id: '0def' },
        { organization_id: 'ghi', requested_hg_id: 'not-this' },
        'junk',
      ],
    }, 'companies');
    expect(index && [...index.keys()]).toEqual(['abc', 'def', 'not-this']);
  });
  it('company_id wins over the other keys on the same entry', () => {
    const index = matchEntries('id', { companies: [{ company_id: 'a1', requested_hg_id: 'b2' }] }, 'companies');
    expect(index && [...index.keys()]).toEqual(['a1']);
  });
  it('matches domains on company_domain', () => {
    const index = matchEntries('domain', { results: [{ company_domain: 'Example.com' }] }, 'results');
    expect(index?.get('example.com')).toEqual({ company_domain: 'Example.com' });
  });
  it('returns null when the response has no array under the key', () => {
    expect(matchEntries('id', { other: [] }, 'companies')).toBeNull();
    expect(matchEntries('id', 'text', 'companies')).toBeNull();
  });
});

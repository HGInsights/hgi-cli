import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { toCsv } from '../../src/output/csv.js';
import { defaultFormat, formatValue, parseFormat } from '../../src/output/format.js';
import { rowsOf } from '../../src/output/rows.js';
import { applySelect } from '../../src/output/select.js';
import { toTable } from '../../src/output/table.js';
import { HgiError, renderError } from '../../src/errors.js';
import { escapeJsonForTerminal, sanitizeForTerminal } from '../../src/output/sanitize.js';

const companies = {
  total: 2,
  companies: [
    { name: 'Acme, Inc.', domain: 'acme.com', tags: ['a', 'b'], hq: { city: 'SF', country: 'US' } },
    { name: 'Bolt "Co"', domain: 'bolt.io', extra: 1 },
  ],
};

describe('rowsOf', () => {
  it('uses an array as rows', () => {
    expect(rowsOf([{ a: 1 }, { a: 2 }]).rows).toHaveLength(2);
  });
  it('picks the single array-of-objects property', () => {
    const r = rowsOf(companies);
    expect(r.collection).toBe(true);
    expect(r.rows).toHaveLength(2);
  });
  it('treats an object with two row arrays as a single row', () => {
    expect(rowsOf({ a: [{ x: 1 }], b: [{ y: 2 }] }).collection).toBe(false);
  });
  it('wraps scalars', () => {
    expect(rowsOf('hi').rows).toEqual(['hi']);
  });
});

describe('formats', () => {
  it('json round-trips and is compact when not pretty', () => {
    const text = formatValue(companies, 'json', { pretty: false });
    expect(text.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(text)).toEqual(companies);
  });
  it('jsonl emits one parseable line per row', () => {
    const lines = formatValue(companies, 'jsonl', { pretty: false }).trim().split('\n');
    expect(lines.map((l) => JSON.parse(l).domain)).toEqual(['acme.com', 'bolt.io']);
  });
  it('csv quotes commas, quotes and nests as JSON, with a union header', () => {
    const csv = toCsv(companies);
    const [header, ...rows] = csv.trim().split('\r\n');
    expect(header).toBe('name,domain,tags,hq,extra');
    expect(rows[0]).toBe('"Acme, Inc.",acme.com,"[""a"",""b""]","{""city"":""SF"",""country"":""US""}",');
    expect(rows[1]).toBe('"Bolt ""Co""",bolt.io,,,1');
  });
  it('yaml round-trips', () => {
    expect(YAML.parse(formatValue(companies, 'yaml', { pretty: false }))).toEqual(companies);
  });
  it('table prints every cell untruncated', () => {
    const long = 'x'.repeat(500);
    const out = toTable([{ name: long }]);
    expect(out).toContain(long);
  });
  it('table of a single object shows field/value', () => {
    expect(toTable({ a: 1, b: 'two' })).toMatch(/field\s+value[\s\S]*a\s+1[\s\S]*b\s+two/);
  });
  it('defaults to table on a TTY and json when piped', () => {
    expect(defaultFormat(true)).toBe('table');
    expect(defaultFormat(false)).toBe('json');
  });
  it('rejects unknown formats with invalid_input', () => {
    expect(() => parseFormat('xml')).toThrow(HgiError);
  });
});

describe('select', () => {
  it('keeps only selected top-level fields', () => {
    expect(applySelect({ a: 1, b: 2, c: 3 }, 'a,c')).toEqual({ a: 1, c: 3 });
  });
  it('maps over arrays and supports dotted paths through arrays', () => {
    expect(applySelect(companies, 'total,companies.name,companies.hq.city')).toEqual({
      total: 2,
      companies: [{ name: 'Acme, Inc.', hq: { city: 'SF' } }, { name: 'Bolt "Co"' }],
    });
  });
  it('a shorter path wins over a longer one', () => {
    expect(applySelect({ a: { b: 1, c: 2 } }, 'a.b,a')).toEqual({ a: { b: 1, c: 2 } });
  });
  it('ignores absent fields and passes scalars through', () => {
    expect(applySelect({ a: 1 }, 'z')).toEqual({});
    expect(applySelect('text', 'a')).toBe('text');
  });
  it('is a no-op without --select and rejects an empty one', () => {
    expect(applySelect({ a: 1 }, undefined)).toEqual({ a: 1 });
    expect(() => applySelect({ a: 1 }, ' , ')).toThrow(HgiError);
  });
});

describe('terminal safety', () => {
  it('neutralises escape sequences and control characters but keeps tabs and newlines', () => {
    const evil = 'a\u001b]0;pwned\u0007b\u001b[2Jc\u009dd\ttab\nline';
    const out = sanitizeForTerminal(evil);
    expect([...out].every((ch) => { const c = ch.codePointAt(0) ?? 0; return c === 9 || c === 10 || (c > 0x1f && (c < 0x7f || c > 0x9f)); })).toBe(true);
    expect(out).toContain('\\x1b');
    expect(out).toContain('\ttab\nline');
  });
  it('a bare carriage return cannot overwrite a line, but CRLF line endings survive', () => {
    expect(sanitizeForTerminal('safe\rdelete')).toBe('safe\\x0ddelete');
    expect(sanitizeForTerminal('a\r\nb')).toBe('a\r\nb');
    expect(toTable([{ name: 'x', note: 'Deletes all.\rsafe_lookup  call' }])).not.toContain('\r');
  });
  it('bidi overrides and invisible formatting marks are made visible, joiners are kept', () => {
    expect(sanitizeForTerminal('a\u202eb')).toBe('a\\u202eb');
    for (const mark of ['\u061c', '\u200e', '\u200f', '\u2028', '\ufeff']) {
      expect(sanitizeForTerminal(`a${mark}b`)).toContain('\\u');
    }
    expect(sanitizeForTerminal('\u{1F468}\u200d\u{1F469}')).toBe('\u{1F468}\u200d\u{1F469}');
  });
  it('JSON on a terminal escapes C1 controls and bidi overrides as \\uXXXX and stays valid, equal JSON', () => {
    const value = { s: 'x\u009b2Jy\u202ez' };
    const raw = JSON.stringify(value);
    const safe = escapeJsonForTerminal(raw);
    expect(safe).not.toMatch(/[\u0080-\u009f\u202a-\u202e]/u);
    expect(JSON.parse(safe)).toEqual(value);
  });
  it('human-readable errors are sanitized; JSON errors escape control characters natively', () => {
    const err = new HgiError('tool_error', 'bad \u001b[31mred\u001b[0m');
    expect(renderError(err, false)).not.toContain('\u001b');
    expect(renderError(new HgiError('tool_error', 'boom\rhgi: ok, nothing ran'), false)).not.toContain('\r');
    expect(renderError(err, true)).not.toContain('\u001b');
    expect(renderError(new HgiError('tool_error', 'x\u009b2Jy\u202ez'), true)).not.toMatch(/[\u0080-\u009f\u202e]/u);
  });
});

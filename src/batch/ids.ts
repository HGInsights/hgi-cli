import { HgiError } from '../errors.js';

export type IdKind = 'id' | 'domain';

export interface IdLine {
  /** The trimmed text, sent as-is and echoed back as the row's `input`. */
  text: string;
  /** 1-based line (or CSV record) number, for messages. */
  line: number;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** One HG id or domain per line; blank lines and `#` comments are skipped. */
export function parseIdLines(text: string): IdLine[] {
  const out: IdLine[] = [];
  stripBom(text)
    .split('\n')
    .forEach((raw, i) => {
      const value = raw.trim();
      if (value === '' || value.startsWith('#')) return;
      out.push({ text: value, line: i + 1 });
    });
  return out;
}

/** RFC 4180: quoted fields, `""` escapes, commas, CR and LF inside quotes, CRLF or LF record ends. */
export function parseCsv(text: string): string[][] {
  const src = stripBom(text);
  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let quoted = false;
  let atCellStart = true;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i] as string;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && atCellStart) {
      quoted = true;
      atCellStart = false;
    } else if (ch === ',') {
      record.push(cell);
      cell = '';
      atCellStart = true;
    } else if (ch === '\n' || (ch === '\r' && src[i + 1] === '\n')) {
      if (ch === '\r') i += 1;
      record.push(cell);
      records.push(record);
      record = [];
      cell = '';
      atCellStart = true;
    } else {
      cell += ch;
      atCellStart = false;
    }
  }
  if (quoted) {
    throw new HgiError('invalid_input', 'The --ids CSV file has a quoted field that is never closed.', {
      details: { reason: 'bad_csv' },
    });
  }
  if (cell !== '' || record.length > 0) {
    record.push(cell);
    records.push(record);
  }
  return records;
}

/** Reads column `column` of a CSV file with a header row; empty cells are skipped. */
export function parseCsvColumn(text: string, column: string): IdLine[] {
  const [header, ...rows] = parseCsv(text);
  const names = (header ?? []).map((h) => h.trim());
  const index = names.indexOf(column.trim());
  if (index < 0) {
    throw new HgiError('invalid_input', `The --ids CSV file has no column "${column}".`, {
      hint: names.length ? `Its columns are: ${names.slice(0, 20).join(', ')}.` : 'The file has no header row.',
      details: { reason: 'unknown_column', column, columns: names.slice(0, 50) },
    });
  }
  const out: IdLine[] = [];
  rows.forEach((row, i) => {
    const value = (row[index] ?? '').trim();
    if (value !== '') out.push({ text: value, line: i + 2 });
  });
  return out;
}

export function classify(text: string): IdKind {
  return text.includes('.') ? 'domain' : 'id';
}

/** HG ids: lowercase, leading zeros dropped (responses can drop them). */
export function normalizeId(text: string): string {
  const lower = text.trim().toLowerCase();
  const stripped = lower.replace(/^0+/, '');
  return stripped === '' && lower !== '' ? '0' : stripped;
}

/** Domains: lowercase, no scheme, no leading `www.`, no path, query or fragment. */
export function normalizeDomain(text: string): string {
  let s = text.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  const cut = s.search(/[/?#]/);
  if (cut >= 0) s = s.slice(0, cut);
  if (s.startsWith('www.')) s = s.slice(4);
  return s;
}

export function normalize(kind: IdKind, text: string): string {
  return kind === 'id' ? normalizeId(text) : normalizeDomain(text);
}

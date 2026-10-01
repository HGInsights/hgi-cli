import YAML from 'yaml';
import { HgiError } from '../errors.js';
import { toCsv } from './csv.js';
import { rowsOf } from './rows.js';
import { toTable } from './table.js';

export const FORMATS = ['json', 'jsonl', 'csv', 'yaml', 'table'] as const;
export type Format = (typeof FORMATS)[number];

export function parseFormat(raw: string): Format {
  if ((FORMATS as readonly string[]).includes(raw)) return raw as Format;
  throw new HgiError('invalid_input', `Unknown format "${raw}". Use one of: ${FORMATS.join(', ')}.`, {
    details: { reason: 'unknown_format' },
  });
}

export function defaultFormat(isTty: boolean): Format {
  return isTty ? 'table' : 'json';
}

export function formatValue(value: unknown, format: Format, opts: { pretty: boolean }): string {
  switch (format) {
    case 'json':
      return `${JSON.stringify(value, null, opts.pretty ? 2 : undefined)}\n`;
    case 'jsonl':
      return `${rowsOf(value)
        .rows.map((r) => JSON.stringify(r))
        .join('\n')}\n`;
    case 'csv':
      return toCsv(value);
    case 'yaml':
      return YAML.stringify(value);
    case 'table':
      return toTable(value);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRowArray(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.length > 0 && value.every(isPlainObject);
}

export interface Rows {
  rows: unknown[];
  collection: boolean;
}

export function rowsOf(value: unknown): Rows {
  if (Array.isArray(value)) return { rows: value, collection: true };
  if (isPlainObject(value)) {
    const candidates = Object.values(value).filter(isRowArray);
    if (candidates.length === 1) return { rows: candidates[0] as unknown[], collection: true };
  }
  return { rows: [value], collection: false };
}

export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}

export function columnsOf(rows: unknown[]): string[] {
  const cols: string[] = [];
  const seen = new Set<string>();
  let sawScalar = false;
  for (const row of rows) {
    if (isPlainObject(row)) {
      for (const key of Object.keys(row)) {
        if (!seen.has(key)) {
          seen.add(key);
          cols.push(key);
        }
      }
    } else {
      sawScalar = true;
    }
  }
  if (sawScalar && !seen.has('value')) cols.push('value');
  return cols;
}

export function rowCells(row: unknown, cols: string[]): string[] {
  if (isPlainObject(row)) return cols.map((c) => cellText(row[c]));
  return cols.map((c) => (c === 'value' ? cellText(row) : ''));
}

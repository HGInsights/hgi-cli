import { cellText, columnsOf, rowCells, rowsOf } from './rows.js';

function oneLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, '\\n');
}

function render(header: string[], body: string[][]): string {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((r) => (r[i] ?? '').length)),
  );
  const fmt = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  const lines = [fmt(header), fmt(widths.map((w) => '-'.repeat(w)))];
  for (const row of body) lines.push(fmt(row));
  return `${lines.join('\n')}\n`;
}

export function toTable(value: unknown): string {
  const { rows, collection } = rowsOf(value);
  if (collection) {
    const cols = columnsOf(rows);
    if (cols.length === 0) return '(no rows)\n';
    return render(
      cols,
      rows.map((r) => rowCells(r, cols).map(oneLine)),
    );
  }
  const single = rows[0];
  if (typeof single === 'object' && single !== null && !Array.isArray(single)) {
    const entries = Object.entries(single as Record<string, unknown>);
    if (entries.length === 0) return '(empty)\n';
    return render(
      ['field', 'value'],
      entries.map(([k, v]) => [k, oneLine(cellText(v))]),
    );
  }
  return `${oneLine(cellText(single))}\n`;
}

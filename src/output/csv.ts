import { columnsOf, rowCells, rowsOf } from './rows.js';

function quote(cell: string): string {
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

export function toCsv(value: unknown): string {
  const { rows } = rowsOf(value);
  const cols = columnsOf(rows);
  const lines = [cols.map(quote).join(',')];
  for (const row of rows) {
    lines.push(rowCells(row, cols).map(quote).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

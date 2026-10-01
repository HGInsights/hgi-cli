import { redact } from './redact.js';

let enabled = false;

export function setDebug(on: boolean): void {
  enabled = on;
}

export function debug(...parts: unknown[]): void {
  if (!enabled) return;
  const text = parts
    .map((p) => (typeof p === 'string' ? p : p instanceof Error ? p.stack ?? p.message : safeStringify(p)))
    .join(' ');
  process.stderr.write(`hgi[debug] ${redact(text)}\n`);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

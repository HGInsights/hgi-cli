import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emit } from '../../src/commands/emit.js';

const evil = { name: 'x\u009b2Jy', note: 'safe\rdelete', bidi: 'a‮b', esc: 'e\u001b]0;pwned\u0007' };
let written = '';

beforeEach(() => {
  written = '';
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
    written += chunk;
    return true;
  }) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
});

function hasRawControl(text: string): boolean {
  const chars = [...text];
  return chars.some((ch, i) => {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0x0d) return chars[i + 1] !== '\n';
    return c === 0x1b || c === 0x07 || (c >= 0x80 && c <= 0x9f) || (c >= 0x202a && c <= 0x202e);
  });
}

describe('emit() on a terminal never forwards raw control characters', () => {
  for (const format of ['table', 'csv', 'yaml', 'json', 'jsonl']) {
    it(`-f ${format}`, async () => {
      await emit([evil], { format });
      expect(written.length).toBeGreaterThan(0);
      expect(hasRawControl(written)).toBe(false);
    });
  }
  it('json and jsonl stay valid, value-identical JSON', async () => {
    await emit(evil, { format: 'json' });
    expect(JSON.parse(written)).toEqual(evil);
  });
});

describe('emit() off a terminal leaves data untouched', () => {
  it('json is byte-faithful when piped', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
    await emit(evil, { format: 'json' });
    expect(JSON.parse(written)).toEqual(evil);
  });
});

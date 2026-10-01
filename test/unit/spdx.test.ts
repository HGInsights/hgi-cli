import { describe, expect, it } from 'vitest';
import { satisfies } from '../../scripts/lib/spdx.mjs';

const allowed = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-3-Clause']);

describe('SPDX allowlist evaluation', () => {
  it.each([
    ['MIT', true],
    ['GPL-3.0', false],
    ['MIT OR GPL-3.0', true],
    ['GPL-3.0 OR MIT', true],
    ['MIT AND ISC', true],
    ['MIT AND GPL-3.0', false],
    ['(MIT AND GPL-3.0) OR Proprietary', false],
    ['(MIT AND ISC) OR Proprietary', true],
    ['MIT OR (GPL-3.0 AND ISC)', true],
    ['GPL-3.0 AND MIT OR ISC', true],
    ['MIT AND GPL-3.0 OR Proprietary', false],
  ])('%s -> %s', (expr, ok) => {
    expect(satisfies(expr, allowed)).toBe(ok);
  });

  it.each(['', 'UNKNOWN', 'MIT WITH Classpath-exception-2.0', '(MIT', 'MIT)', 'MIT OR', 'AND MIT', 'MIT MIT', 'SEE LICENSE IN LICENSE.txt'])(
    'fails closed on %j',
    (expr) => {
      expect(satisfies(expr, allowed)).toBe(false);
    },
  );
});

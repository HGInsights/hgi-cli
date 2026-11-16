import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SKILL_MD } from '../../src/generated/skill-md.js';

const read = (p: string) => fs.readFileSync(p, 'utf8');

describe('--all-pages is documented', () => {
  it('docs/exit-codes.md: the partial-result exception and every new reason', () => {
    const doc = read('docs/exit-codes.md');
    const body = doc.split(/^## The error body$/m)[1]?.split(/^## /m)[0] ?? '';
    expect(body).toContain('`details.partial_result: true`');
    const section = doc.split(/^## Partial output from `--all-pages`$/m)[1]?.split(/^## /m)[0] ?? '';
    for (const text of ['not_pageable', 'max_pages_without_all_pages', 'bad_max_pages', 'offset_with_all_pages', 'all_pages_with_ids', 'partial_result', 'pages_fetched', 'truncated_reason']) {
      expect(section).toContain(text);
    }
  });

  it('docs/output-formats.md: the merged shape, truncation and the --meta additions', () => {
    const section = read('docs/output-formats.md').split(/^## `hgi call --all-pages`$/m)[1]?.split(/^## /m)[0] ?? '';
    for (const text of ['pages_fetched', 'truncated_reason', '`max_pages`', '`unmatched`', 'calls_without_cost', 'billed call']) {
      expect(section).toContain(text);
    }
  });

  it('skills/hgi/SKILL.md: a paging section and partial_result in the exit table, and the embedded copy is current', () => {
    const skill = read('skills/hgi/SKILL.md');
    expect(skill).toContain('### Paging (`--all-pages`)');
    expect(skill).toMatch(/^\| any, with `details\.partial_result: true` \|/m);
    expect(SKILL_MD).toBe(skill);
  });
});

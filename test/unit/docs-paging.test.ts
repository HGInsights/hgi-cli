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
    for (const text of ['not_pageable', 'max_pages_without_all_pages', 'bad_max_pages', 'offset_with_all_pages', 'partial_result', 'pages_fetched', 'truncated_reason']) {
      expect(section).toContain(text);
    }
  });

  it('docs/output-formats.md: the merged shape, truncation and the --meta additions', () => {
    const section = read('docs/output-formats.md').split(/^## `hgi call --all-pages`$/m)[1]?.split(/^## /m)[0] ?? '';
    for (const text of ['pages_fetched', 'truncated_reason', '`max_pages`', '`unmatched`', 'calls_without_cost', 'billed call']) {
      expect(section).toContain(text);
    }
  });

  it('--ids with --all-pages: both docs and the skill describe the combination; the old refusal is gone', () => {
    const formats = read('docs/output-formats.md').split(/^### `--ids` with `--all-pages`$/m)[1]?.split(/^## /m)[0] ?? '';
    for (const text of ['one company per call', 'merged entry', 'pages_fetched', '`tool_error`', 'per company', 'truncated_rows', 'input order']) {
      expect(formats).toContain(text);
    }
    const codes = read('docs/exit-codes.md');
    const ids = codes.split(/^## Partial output from `--ids`$/m)[1]?.split(/^## /m)[0] ?? '';
    for (const text of ['**With `--all-pages` too**', 'paging_failures', 'partial_result: true', '#partial-output-from---all-pages', 'truncated_reason: "tool_error"']) {
      expect(ids).toContain(text);
    }
    const skill = read('skills/hgi/SKILL.md');
    expect(skill).toContain('hgi call <tool> --ids @hg_ids.txt --all-pages');
    for (const doc of [codes, read('docs/output-formats.md'), skill]) expect(doc).not.toContain('all_pages_with_ids');
  });

  it('skills/hgi/SKILL.md: a paging section and partial_result in the exit table, and the embedded copy is current', () => {
    const skill = read('skills/hgi/SKILL.md');
    expect(skill).toContain('### Paging (`--all-pages`)');
    expect(skill).toMatch(/^\| any, with `details\.partial_result: true` \|/m);
    expect(SKILL_MD).toBe(skill);
  });
});

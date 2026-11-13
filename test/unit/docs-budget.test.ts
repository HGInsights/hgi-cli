import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ERROR_EXIT } from '../../src/errors.js';

const read = (p: string) => fs.readFileSync(p, 'utf8');

describe('docs/exit-codes.md documents the refusal codes and the run cap', () => {
  const doc = read('docs/exit-codes.md');
  const rows = new Map(
    [...doc.matchAll(/^\| (\d+) \| (.*)$/gm)].map((m) => [Number(m[1]), m[2] as string]),
  );

  it('lists every error code on the row of its exit code', () => {
    for (const [code, exit] of Object.entries(ERROR_EXIT)) {
      expect(rows.get(exit) ?? '', `${code} on row ${exit}`).toContain(`\`${code}\``);
    }
  });

  it('documents the new details fields and kinds', () => {
    for (const text of ['server_error_code', 'retryable', 'budget_write_failed', 'budget_corrupt', '`spent`, `max` and `budget_id`']) {
      expect(doc).toContain(text);
    }
  });

  it('has a Run cap section with the client-side, call-only and overshoot wording', () => {
    const section = doc.split(/^## Run cap$/m)[1] ?? '';
    expect(section).toMatch(/client-side only, on top of the server's limits/);
    expect(section).toMatch(/`hgi call` only/);
    expect(section).toMatch(/`hgi run`.*neither checked nor counted/);
    expect(section).toMatch(/overshoot/);
    expect(section).toMatch(/counts as 0/);
  });
});

describe('skills/hgi/SKILL.md tells agents about the new codes and the run cap', () => {
  const skill = read('skills/hgi/SKILL.md');
  it('has rows for the new codes and exit 13, and the HGI_BUDGET_ID advice', () => {
    for (const text of ['user_credit_limit_exceeded', 'governance_unavailable', 'tool_not_enabled_for_team', 'phoenix_account_required', '| 13 `budget_exceeded`']) {
      expect(skill).toContain(text);
    }
    expect(skill).toMatch(/## Run cap[\s\S]*export HGI_BUDGET_ID=/);
  });
});

describe('docs/security.md', () => {
  it('says where budget files live and that they hold no tokens', () => {
    const doc = read('docs/security.md');
    expect(doc).toContain('~/.config/hgi/budgets/');
    expect(doc).toMatch(/spend counters only, no tokens/);
  });
});

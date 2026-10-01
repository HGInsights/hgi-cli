import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SKILL_MD } from '../../src/generated/skill-md.js';

describe('embedded SKILL.md', () => {
  it('matches skills/hgi/SKILL.md byte for byte (run `npm run gen:skill` after editing the skill)', () => {
    expect(SKILL_MD).toBe(fs.readFileSync('skills/hgi/SKILL.md', 'utf8'));
  });
});

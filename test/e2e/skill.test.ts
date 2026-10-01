import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeSandbox, runCli, type Sandbox } from '../support/cli.js';
import { errorBody } from '../support/e2e.js';

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox('http://127.0.0.1:9');
});
afterEach(() => sb.cleanup());

const skillFile = fs.readFileSync('skills/hgi/SKILL.md', 'utf8');

describe('SKILL.md (Story 10)', () => {
  it('has the frontmatter Claude Code needs for discovery', () => {
    const match = /^---\nname: hgi\ndescription: (.+)\n---\n/.exec(skillFile);
    expect(match).not.toBeNull();
    expect((match?.[1] ?? '').length).toBeGreaterThan(40);
  });
  it('is auto-discoverable from the repo through .claude/skills', () => {
    expect(fs.lstatSync('.claude/skills/hgi').isSymbolicLink()).toBe(true);
    expect(fs.readFileSync('.claude/skills/hgi/SKILL.md', 'utf8')).toBe(skillFile);
  });
  it('states the rules: list tools first, call for lookups, ask before run, report credit cost, the allowlist', () => {
    expect(skillFile).toMatch(/List tools first[\s\S]*hgi tools list --json/);
    expect(skillFile).toMatch(/hgi call[\s\S]*lookups/);
    expect(skillFile).toMatch(/hgi run[\s\S]*only with the user's approval/i);
    expect(skillFile).toMatch(/Report the credit cost after every call/);
    expect(skillFile).toContain('"allow": ["Bash(hgi call *)"');
    expect(skillFile).toContain('"ask": ["Bash(hgi run *)"]');
  });
  it('documents every exit code the CLI can return', () => {
    for (const code of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      expect(skillFile).toMatch(new RegExp(`\\| ${code} \\|`));
    }
  });
  it('warns agents that outcome_unknown applies to any exit code of a run', () => {
    expect(skillFile).toMatch(/outcome_unknown: true`, whatever its exit code \(1, 7 or 9\)/);
    expect(skillFile).toMatch(/\| 9 \|[^\n]*outcome_unknown/);
  });
  it('is shipped in the npm package', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { files: string[] };
    expect(pkg.files).toContain('skills');
  });
});

describe('hgi skill install', () => {
  it('installs, is idempotent, and refuses to clobber a different file without --force', async () => {
    const dir = path.join(sb.dir, 'skills');
    const first = await runCli(['skill', 'install', '--dir', dir], sb.env);
    expect(first.code, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout).result).toBe('installed');
    expect(fs.readFileSync(path.join(dir, 'hgi', 'SKILL.md'), 'utf8')).toBe(skillFile);
    expect(JSON.parse((await runCli(['skill', 'install', '--dir', dir], sb.env)).stdout).result).toBe('unchanged');

    fs.writeFileSync(path.join(dir, 'hgi', 'SKILL.md'), 'local edits');
    const clash = await runCli(['skill', 'install', '--dir', dir], sb.env);
    expect(clash.code).toBe(2);
    expect(errorBody(clash).error.details?.reason).toBe('exists');
    expect(fs.readFileSync(path.join(dir, 'hgi', 'SKILL.md'), 'utf8')).toBe('local edits');
    const forced = await runCli(['skill', 'install', '--dir', dir, '--force'], sb.env);
    expect(JSON.parse(forced.stdout).result).toBe('replaced');
  });
  it('defaults to ~/.claude/skills and honors CLAUDE_CONFIG_DIR', async () => {
    const res = await runCli(['skill', 'install'], sb.env);
    expect(res.code, res.stderr).toBe(0);
    expect(fs.existsSync(path.join(sb.dir, '.claude', 'skills', 'hgi', 'SKILL.md'))).toBe(true);
    const custom = path.join(sb.dir, 'claude-cfg');
    await runCli(['skill', 'install'], { ...sb.env, CLAUDE_CONFIG_DIR: custom });
    expect(fs.existsSync(path.join(custom, 'skills', 'hgi', 'SKILL.md'))).toBe(true);
  });
  it('refuses to install through a symlink', async () => {
    const real = path.join(sb.dir, 'real');
    fs.mkdirSync(real);
    const link = path.join(sb.dir, 'linked-skills');
    fs.symlinkSync(real, link);
    const res = await runCli(['skill', 'install', '--dir', link], sb.env);
    expect(res.code).toBe(2);
    expect(fs.readdirSync(real)).toEqual([]);
  });
});

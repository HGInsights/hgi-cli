import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { HgiError } from '../errors.js';
import { SKILL_MD } from '../generated/skill-md.js';
import { emit } from './emit.js';

function defaultSkillsDir(): string {
  const claude = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  return path.join(claude, 'skills');
}

function refuse(message: string, reason: string): HgiError {
  return new HgiError('invalid_input', message, { details: { reason } });
}

export function installSkill(opts: { dir?: string; force?: boolean }): { path: string; result: 'installed' | 'unchanged' | 'replaced' } {
  const skillsDir = path.resolve(opts.dir ?? defaultSkillsDir());
  const targetDir = path.join(skillsDir, 'hgi');
  const target = path.join(targetDir, 'SKILL.md');

  for (const guarded of [skillsDir, targetDir]) {
    try {
      const st = fs.lstatSync(guarded);
      if (st.isSymbolicLink()) throw refuse(`Refusing to install through the symlink ${guarded}.`, 'symlink');
      if (!st.isDirectory()) throw refuse(`${guarded} is not a directory.`, 'not_a_directory');
    } catch (err) {
      if (err instanceof HgiError) throw err;
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  fs.mkdirSync(targetDir, { recursive: true });

  let existing: fs.Stats | null = null;
  try {
    existing = fs.lstatSync(target);
  } catch {
    existing = null;
  }
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) throw refuse(`${target} is not a regular file.`, 'not_regular_file');
    if (fs.readFileSync(target, 'utf8') === SKILL_MD) return { path: target, result: 'unchanged' };
    if (!opts.force) {
      throw refuse(`${target} already exists and differs.`, 'exists');
    }
    fs.unlinkSync(target);
    fs.writeFileSync(target, SKILL_MD, { flag: 'wx', mode: 0o644 });
    return { path: target, result: 'replaced' };
  }
  fs.writeFileSync(target, SKILL_MD, { flag: 'wx', mode: 0o644 });
  return { path: target, result: 'installed' };
}

export function registerSkillCommands(program: Command): void {
  const skill = program.command('skill').description('Install the hgi skill for AI coding agents');
  skill
    .command('install')
    .description('Copy SKILL.md to ~/.claude/skills/hgi so Claude Code discovers it')
    .option('--dir <skills-dir>', 'skills directory (default: ~/.claude/skills)')
    .option('--force', 'replace an existing, different SKILL.md')
    .option('-f, --format <format>', 'json|jsonl|csv|yaml|table')
    .action(async (opts: { dir?: string; force?: boolean; format?: string }) => {
      await emit(installSkill(opts), { format: opts.format });
    });
}

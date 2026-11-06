import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PRUNE_AFTER_MS,
  budgetPath,
  budgetsDir,
  checkBudget,
  parseMaxCredits,
  pruneBudgets,
  readBudget,
  recordSpend,
  resetBudget,
  resolveBudgetId,
  resolveMaxCredits,
} from '../../src/budget.js';
import { HgiError } from '../../src/errors.js';

let tmp: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hgi-budget-'));
  env = { HGI_CONFIG_DIR: path.join(tmp, 'config') };
});
afterEach(() => {
  try {
    fs.chmodSync(path.join(tmp, 'config', 'budgets'), 0o700);
  } catch {
    // not created
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function caught(p: Promise<unknown> | (() => unknown)): Promise<HgiError> {
  try {
    if (typeof p === 'function') p();
    else await p;
  } catch (err) {
    return err as HgiError;
  }
  throw new Error('expected an error');
}

const mode = (p: string) => fs.statSync(p).mode & 0o777;

describe('cap and budget id resolution', () => {
  it('parseMaxCredits accepts non-negative integers only', async () => {
    expect(parseMaxCredits('0', 'x')).toBe(0);
    expect(parseMaxCredits('50', 'x')).toBe(50);
    for (const bad of ['-1', '1.5', 'abc', '', '1e3', ' 5', '9007199254740993']) {
      const err = await caught(() => parseMaxCredits(bad, '--max-credits'));
      expect(err.code, bad).toBe('invalid_input');
      expect(err.details?.reason).toBe('max_credits');
    }
  });

  it('the flag wins over HGI_MAX_CREDITS; an empty variable is unset', () => {
    expect(resolveMaxCredits('10', { HGI_MAX_CREDITS: '5' })).toBe(10);
    expect(resolveMaxCredits(undefined, { HGI_MAX_CREDITS: '5' })).toBe(5);
    expect(resolveMaxCredits(undefined, { HGI_MAX_CREDITS: '' })).toBeNull();
    expect(resolveMaxCredits(undefined, {})).toBeNull();
  });

  it('HGI_BUDGET_ID wins; otherwise the parent process id', () => {
    expect(resolveBudgetId({ HGI_BUDGET_ID: 'task-1' })).toBe('task-1');
    expect(resolveBudgetId({ HGI_BUDGET_ID: '' })).toBe(String(process.ppid));
    expect(resolveBudgetId({})).toBe(String(process.ppid));
  });
});

describe('budget file', () => {
  it('is named by the first 16 hex chars of sha256(id), inside budgets/, whatever the id', () => {
    const want = `${createHash('sha256').update('t').digest('hex').slice(0, 16)}.json`;
    expect(path.basename(budgetPath('t', env))).toBe(want);
    const evil = budgetPath('../../x', env);
    expect(path.dirname(evil)).toBe(budgetsDir(env));
    expect(path.basename(evil)).toMatch(/^[0-9a-f]{16}\.json$/);
  });

  it('a missing file reads as zeros', () => {
    expect(readBudget('t', env)).toMatchObject({ budget_id: 't', spent: 0, calls: 0, unknown_cost_calls: 0, max: null });
  });

  it('records known and unknown costs, mode 0600 in a 0700 dir', async () => {
    await recordSpend('t', 5, 2, env);
    await recordSpend('t', 5, null, env);
    await recordSpend('t', 5, -1, env);
    const s = await recordSpend('t', 7, 3, env);
    expect(s).toMatchObject({ spent: 5, calls: 4, unknown_cost_calls: 2, max: 7 });
    expect(readBudget('t', env)).toMatchObject({ spent: 5, calls: 4, unknown_cost_calls: 2, max: 7 });
    expect(mode(budgetPath('t', env))).toBe(0o600);
    expect(mode(budgetsDir(env))).toBe(0o700);
    expect(fs.readdirSync(budgetsDir(env)).filter((f) => f.endsWith('.json'))).toHaveLength(1);
  });

  it('checkBudget refuses with exit 13 once spent reaches the cap', async () => {
    await expect(checkBudget('t', 0, env)).rejects.toMatchObject({ code: 'budget_exceeded', details: { spent: 0, max: 0, budget_id: 't' } });
    await recordSpend('t', 5, 4, env);
    await expect(checkBudget('t', 5, env)).resolves.toMatchObject({ spent: 4 });
    await recordSpend('t', 5, 2, env);
    const err = await caught(checkBudget('t', 5, env));
    expect(err.exitCode).toBe(13);
    expect(err.details).toEqual({ spent: 6, max: 5, budget_id: 't' });
    expect(err.hint).toMatch(/Nothing was sent/);
  });

  it.each([
    ['invalid JSON', '{nope'],
    ['an array', '[]'],
    ['a wrong schema', JSON.stringify({ schema: 2, budget_id: 't', spent: 0, calls: 0, unknown_cost_calls: 0, max: null, updated_at: '2026-01-01T00:00:00.000Z' })],
    ['a negative spend', JSON.stringify({ schema: 1, budget_id: 't', spent: -1, calls: 0, unknown_cost_calls: 0, max: null, updated_at: '2026-01-01T00:00:00.000Z' })],
    ['another budget id', JSON.stringify({ schema: 1, budget_id: 'u', spent: 0, calls: 0, unknown_cost_calls: 0, max: null, updated_at: '2026-01-01T00:00:00.000Z' })],
    ['fractional calls', JSON.stringify({ schema: 1, budget_id: 't', spent: 0, calls: 0.5, unknown_cost_calls: 0, max: null, updated_at: '2026-01-01T00:00:00.000Z' })],
    ['more unknown-cost calls than calls', JSON.stringify({ schema: 1, budget_id: 't', spent: 0, calls: 1, unknown_cost_calls: 2, max: null, updated_at: '2026-01-01T00:00:00.000Z' })],
    ['a fractional max', JSON.stringify({ schema: 1, budget_id: 't', spent: 0, calls: 0, unknown_cost_calls: 0, max: 1.5, updated_at: '2026-01-01T00:00:00.000Z' })],
    ['no updated_at', JSON.stringify({ schema: 1, budget_id: 't', spent: 0, calls: 0, unknown_cost_calls: 0, max: null })],
    ['a bad updated_at', JSON.stringify({ schema: 1, budget_id: 't', spent: 0, calls: 0, unknown_cost_calls: 0, max: null, updated_at: 'yesterday' })],
  ])('fails closed on %s: budget_corrupt on read and check, budget_write_failed on record', async (_label, body) => {
    fs.mkdirSync(budgetsDir(env), { recursive: true, mode: 0o700 });
    fs.writeFileSync(budgetPath('t', env), body, { mode: 0o600 });
    expect((await caught(() => readBudget('t', env))).details?.kind).toBe('budget_corrupt');
    const check = await caught(checkBudget('t', 5, env));
    expect(check.code).toBe('local_state_error');
    expect(check.details?.kind).toBe('budget_corrupt');
    expect((await caught(recordSpend('t', 5, 1, env))).details?.kind).toBe('budget_write_failed');
  });

  it('refuses a symlink at the file path, and at the config or budgets dir', async () => {
    fs.mkdirSync(budgetsDir(env), { recursive: true, mode: 0o700 });
    const target = path.join(tmp, 'elsewhere.json');
    fs.writeFileSync(target, '{}');
    fs.symlinkSync(target, budgetPath('t', env));
    expect((await caught(() => readBudget('t', env))).details?.kind).toBe('budget_corrupt');
    expect((await caught(recordSpend('t', 5, 1, env))).details?.kind).toBe('budget_write_failed');
    expect(fs.readFileSync(target, 'utf8')).toBe('{}');

    for (const linked of ['config', 'budgets'] as const) {
      const root = fs.mkdtempSync(path.join(tmp, 'link-'));
      const real = path.join(root, 'real');
      fs.mkdirSync(real, { mode: 0o700 });
      const cfg = path.join(root, 'config');
      if (linked === 'config') fs.symlinkSync(real, cfg);
      else {
        fs.mkdirSync(cfg, { mode: 0o700 });
        fs.symlinkSync(real, path.join(cfg, 'budgets'));
      }
      const e = { HGI_CONFIG_DIR: cfg };
      expect((await caught(() => readBudget('t', e))).details?.kind, linked).toBe('budget_corrupt');
      expect((await caught(checkBudget('t', 5, e))).details?.kind, linked).toBe('budget_corrupt');
      expect((await caught(recordSpend('t', 5, 1, e))).details?.kind, linked).toBe('budget_write_failed');
      expect(fs.readdirSync(real), linked).toEqual([]);
    }
  });

  it.skipIf(process.getuid?.() === 0)('a budgets/ dir hgi cannot write to fails at once, without mentioning credentials', async () => {
    await recordSpend('t', 5, 1, env);
    fs.chmodSync(budgetsDir(env), 0o500);
    const started = Date.now();
    const check = await caught(checkBudget('t', 5, env));
    expect(check.details?.kind).toBe('budget_corrupt');
    expect(check.message).not.toMatch(/credentials/);
    const record = await caught(recordSpend('t', 5, 1, env));
    expect(record.details?.kind).toBe('budget_write_failed');
    expect(record.message).not.toMatch(/credentials/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a held budget lock that times out says "budget lock"', async () => {
    const { withLock } = await import('../../src/auth/credentials-store.js');
    // A directory where the lock's owner file goes makes stamping fail, which reports the lock's label.
    fs.mkdirSync(path.join(budgetsDir(env), 'x.json.lock-owner'), { recursive: true });
    const err = await caught(withLock(path.join(budgetsDir(env), 'x.json'), async () => 1, undefined, 'budget'));
    expect(err.message).toMatch(/budget lock/);
    expect(err.message).not.toMatch(/credentials/);
  });

  it('reset zeroes the counters of one id only, keeps its cap, and repairs a corrupt file', async () => {
    await recordSpend('t', 5, 4, env);
    await recordSpend('other', 9, 1, env);
    const other = fs.readFileSync(budgetPath('other', env), 'utf8');
    expect(await resetBudget('t', env)).toMatchObject({ spent: 0, calls: 0, unknown_cost_calls: 0, max: 5 });
    expect(readBudget('t', env)).toMatchObject({ spent: 0, calls: 0, max: 5 });
    expect(fs.readFileSync(budgetPath('other', env), 'utf8')).toBe(other);

    fs.writeFileSync(budgetPath('t', env), '{nope', { mode: 0o600 });
    expect(await resetBudget('t', env)).toMatchObject({ spent: 0, max: null });
    expect(readBudget('t', env).spent).toBe(0);
  });

  it('prunes budget files idle for more than 7 days on the next write, and nothing else', async () => {
    const dir = budgetsDir(env);
    await recordSpend('old', 5, 1, env);
    await recordSpend('recent', 5, 1, env);
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep');
    const now = Date.now();
    const age = (id: string, ms: number) => fs.utimesSync(budgetPath(id, env), (now - ms) / 1000, (now - ms) / 1000);
    age('old', PRUNE_AFTER_MS + 24 * 3600_000);
    age('recent', PRUNE_AFTER_MS - 24 * 3600_000);
    await recordSpend('t', 5, 1, env);
    expect(fs.existsSync(budgetPath('old', env))).toBe(false);
    expect(fs.existsSync(budgetPath('recent', env))).toBe(true);
    expect(fs.existsSync(budgetPath('t', env))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'notes.txt'))).toBe(true);
    pruneBudgets(path.join(tmp, 'missing'));
  });
});

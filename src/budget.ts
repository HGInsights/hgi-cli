import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, withLock, writePrivateFile, type HeldLock } from './auth/credentials-store.js';
import { configDir } from './config.js';
import { debug } from './debug.js';
import { HgiError } from './errors.js';

type Env = NodeJS.ProcessEnv;

/** What a budget file holds: spend counters for one run, never a token. */
export interface BudgetState {
  schema: 1;
  budget_id: string;
  spent: number;
  calls: number;
  unknown_cost_calls: number;
  /** The cap of the last capped call, or null when none has been recorded (a fresh reset). */
  max: number | null;
  updated_at: string;
}

type BudgetKind = 'budget_corrupt' | 'budget_write_failed';

/** Budget files with no write for this long are deleted on the next budget write. */
export const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** `HGI_BUDGET_ID` when set, otherwise the parent process id, so every hgi from one shell or script shares a budget. */
export function resolveBudgetId(env: Env = process.env): string {
  const id = env.HGI_BUDGET_ID;
  return id ? id : String(process.ppid);
}

export function parseMaxCredits(raw: string, source: string): number {
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value)) {
    throw new HgiError('invalid_input', `${source} must be a non-negative whole number of credits, not "${raw}".`, {
      hint: 'For example --max-credits 50. 0 refuses every call.',
      details: { reason: 'max_credits' },
    });
  }
  return value;
}

/** The active cap: `--max-credits` wins over `HGI_MAX_CREDITS`; an empty variable counts as unset. */
export function resolveMaxCredits(flag: string | undefined, env: Env = process.env): number | null {
  if (flag !== undefined) return parseMaxCredits(flag, '--max-credits');
  const fromEnv = env.HGI_MAX_CREDITS;
  if (fromEnv) return parseMaxCredits(fromEnv, 'HGI_MAX_CREDITS');
  return null;
}

export function budgetsDir(env: Env = process.env): string {
  return path.join(configDir(env), 'budgets');
}

/** The id is never used in a path: the file is named by the first 16 hex characters of its SHA-256. */
export function budgetPath(id: string, env: Env = process.env): string {
  const name = createHash('sha256').update(id).digest('hex').slice(0, 16);
  return path.join(budgetsDir(env), `${name}.json`);
}

function budgetError(kind: BudgetKind, message: string, hint: string, cause?: unknown): HgiError {
  return new HgiError('local_state_error', message, { hint, details: { kind }, cause });
}

const CORRUPT_HINT = 'Run `hgi budget reset` to start the count over, or delete the file.';

/**
 * `writePrivateFile` and `ensureDir` check only the file and its parent, so the config dir above
 * `budgets/` is checked here: a symlink or non-directory at either level is refused.
 */
function assertDirsSafe(env: Env, kind: BudgetKind): void {
  for (const dir of [configDir(env), budgetsDir(env)]) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(dir);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw budgetError(
        kind,
        `Budget directory is unsafe (${st.isSymbolicLink() ? 'symlink' : 'not a directory'}): ${dir}`,
        'Remove or fix it yourself; hgi will not follow symlinks.',
      );
    }
  }
}

/**
 * Takes the budget lock. proper-lockfile retries every lock error for over a minute, not only a held
 * lock, so a directory hgi cannot write to is refused first, at once.
 */
async function withBudgetLock<T>(file: string, kind: BudgetKind, fn: (lock: HeldLock) => Promise<T>): Promise<T> {
  const dir = path.dirname(file);
  ensureDir(dir);
  try {
    fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
  } catch (err) {
    throw budgetError(kind, `Cannot write to the budget directory ${dir}: ${(err as NodeJS.ErrnoException).code ?? 'error'}.`, `Make ${dir} writable (chmod 700), then retry.`, err);
  }
  return withLock(file, fn, undefined, 'budget');
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isState(value: unknown, id: string): value is BudgetState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const b = value as Record<string, unknown>;
  return (
    b.schema === 1 &&
    b.budget_id === id &&
    isCount(b.spent) &&
    isCount(b.calls) &&
    Number.isSafeInteger(b.calls) &&
    isCount(b.unknown_cost_calls) &&
    Number.isSafeInteger(b.unknown_cost_calls) &&
    (b.unknown_cost_calls as number) <= (b.calls as number) &&
    (b.max === null || (isCount(b.max) && Number.isSafeInteger(b.max))) &&
    typeof b.updated_at === 'string' &&
    !Number.isNaN(Date.parse(b.updated_at))
  );
}

function emptyState(id: string, now: number): BudgetState {
  return { schema: 1, budget_id: id, spent: 0, calls: 0, unknown_cost_calls: 0, max: null, updated_at: new Date(now).toISOString() };
}

/** Reads one budget file. Missing → zeros. Anything unreadable or malformed → exit 12 `budget_corrupt`. */
function readFile(file: string, id: string): BudgetState | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw budgetError(
      'budget_corrupt',
      code === 'ELOOP' ? `Budget file is a symlink: ${file}` : `Cannot read budget file ${file}: ${code ?? 'error'}.`,
      code === 'ELOOP' ? 'Remove it yourself; hgi will not follow symlinks.' : CORRUPT_HINT,
      err,
    );
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw budgetError('budget_corrupt', `Budget path is not a regular file: ${file}`, 'Remove it yourself.');
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } catch (err) {
      throw budgetError('budget_corrupt', `Budget file is corrupt: ${file}`, CORRUPT_HINT, err);
    }
    if (!isState(parsed, id)) throw budgetError('budget_corrupt', `Budget file is corrupt: ${file}`, CORRUPT_HINT);
    return parsed;
  } finally {
    fs.closeSync(fd);
  }
}

/** The current state of a budget, without the lock (the file is replaced by an atomic rename, so a read never sees half a write). */
export function readBudget(id: string, env: Env = process.env, now = Date.now()): BudgetState {
  assertDirsSafe(env, 'budget_corrupt');
  return readFile(budgetPath(id, env), id) ?? emptyState(id, now);
}

function writeState(lock: HeldLock, file: string, state: BudgetState): void {
  lock.assertHeld();
  writePrivateFile(file, `${JSON.stringify(state)}\n`, { beforeRename: () => lock.assertHeld() });
}

/** Best effort: removes budget files idle for more than 7 days. Lock directories and owner files are left alone. */
export function pruneBudgets(dir: string, now = Date.now()): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      const st = fs.lstatSync(file);
      if (st.isFile() && now - st.mtimeMs > PRUNE_AFTER_MS) fs.unlinkSync(file);
    } catch (err) {
      debug('budget prune skipped', name, err);
    }
  }
}

/** Before a capped call: refuses with exit 13 when the budget is already spent. Sends nothing. */
export async function checkBudget(id: string, max: number, env: Env = process.env): Promise<BudgetState> {
  assertDirsSafe(env, 'budget_corrupt');
  const file = budgetPath(id, env);
  const state = await withBudgetLock(file, 'budget_corrupt', async () => readFile(file, id) ?? emptyState(id, Date.now()));
  if (state.spent >= max) {
    throw new HgiError('budget_exceeded', `This run's credit cap is reached: ${state.spent} of ${max} credits spent (budget ${id}).`, {
      hint: 'Nothing was sent. Raise --max-credits or HGI_MAX_CREDITS, or start the count over with `hgi budget reset`.',
      details: { spent: state.spent, max, budget_id: id },
    });
  }
  return state;
}

/**
 * After a capped call: adds the reported cost (0 and one more `unknown_cost_calls` when there is none)
 * and one call. Any failure, a corrupt file included, is exit 12 `budget_write_failed`.
 */
export async function recordSpend(id: string, max: number, cost: number | null, env: Env = process.env, now = Date.now()): Promise<BudgetState> {
  try {
    assertDirsSafe(env, 'budget_write_failed');
    const file = budgetPath(id, env);
    const next = await withBudgetLock(file, 'budget_write_failed', async (lock) => {
      const prev = readFile(file, id) ?? emptyState(id, now);
      const known = cost !== null && Number.isFinite(cost) && cost >= 0;
      const state: BudgetState = {
        schema: 1,
        budget_id: id,
        spent: prev.spent + (known ? cost : 0),
        calls: prev.calls + 1,
        unknown_cost_calls: prev.unknown_cost_calls + (known ? 0 : 1),
        max,
        updated_at: new Date(now).toISOString(),
      };
      writeState(lock, file, state);
      return state;
    });
    pruneBudgets(path.dirname(file), now);
    return next;
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw budgetError('budget_write_failed', `Could not record this call's spend: ${cause}`, CORRUPT_HINT, err);
  }
}

/** Zeroes the counters of one budget, keeping its stored cap. A corrupt file is reset too: this is the way out of one. */
export async function resetBudget(id: string, env: Env = process.env, now = Date.now()): Promise<BudgetState> {
  assertDirsSafe(env, 'budget_write_failed');
  const file = budgetPath(id, env);
  const next = await withBudgetLock(file, 'budget_write_failed', async (lock) => {
    let max: number | null = null;
    try {
      max = readFile(file, id)?.max ?? null;
    } catch (err) {
      if (!(err instanceof HgiError && err.details?.kind === 'budget_corrupt')) throw err;
    }
    const state: BudgetState = { ...emptyState(id, now), max };
    try {
      writeState(lock, file, state);
    } catch (err) {
      if (err instanceof HgiError && err.details?.kind === 'lock_compromised') throw err;
      throw budgetError('budget_write_failed', `Could not reset ${file}: ${err instanceof Error ? err.message : String(err)}`, 'Remove the file yourself, then retry.', err);
    }
    return state;
  });
  pruneBudgets(path.dirname(file), now);
  return next;
}

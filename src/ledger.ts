import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './auth/credentials-store.js';
import { configDir, guardLedgerOverride } from './config.js';
import { HgiError } from './errors.js';
import { withFileLock, type FileLockHandle, type LockRetries } from './file-lock.js';
import { redact } from './redact.js';

// The local credit ledger: one JSON line per `tools/call` that got a result back. Format v1 is an
// interface (docs/output-formats.md): new keys may be added, existing keys keep their meaning.

export type LedgerVerb = 'call' | 'run';
export type LedgerStatus = 'ok' | 'tool_error';

export interface LedgerRecord {
  v: 1;
  ts: string;
  host: string;
  verb: LedgerVerb;
  tool: string;
  label: string | null;
  credit_cost: number | null;
  budget_id: string | null;
  mcp_version: string | null;
  status: LedgerStatus;
}

const LEDGER_FILE = 'ledger.jsonl';

/** About 5 s in total (3.6 to 7 s with jitter): an append holds the lock for a few milliseconds. */
const LEDGER_LOCK_RETRIES: LockRetries = { retries: 9, factor: 1.5, minTimeout: 70, maxTimeout: 700, randomize: true };

type Env = NodeJS.ProcessEnv;

/** The ledger path, or `null` when `HGI_LEDGER=off`. Throws `workspace_guard` for an override in a repo. */
export function ledgerPath(env: Env = process.env): string | null {
  const raw = env.HGI_LEDGER;
  if (raw === 'off') return null;
  if (raw) return guardLedgerOverride(raw);
  return path.join(configDir(env), LEDGER_FILE);
}

export function budgetId(env: Env = process.env): string | null {
  return env.HGI_BUDGET_ID ? env.HGI_BUDGET_ID : null;
}

const LABEL = /^[A-Za-z0-9._:/-]{1,64}$/;

export function parseLabel(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  if (LABEL.test(raw)) return raw;
  throw new HgiError('invalid_input', '--label must be 1 to 64 characters from A-Z a-z 0-9 . _ : / -', {
    hint: 'For example: --label resolve or --label enrich/pass-2. Nothing was sent.',
    details: { reason: 'bad_label' },
  });
}

const MCP_VERSION = /^[A-Za-z0-9._-]{1,32}$/;

/** The MCP version comes from a server response header: keep it only when it is short, plain and no secret. */
export function sanitizeMcpVersion(value: unknown): string | null {
  return typeof value === 'string' && MCP_VERSION.test(value) && redact(value) === value ? value : null;
}

function redactOrNull(value: string | null): string | null {
  return value === null ? null : redact(value);
}

export function serializeRecord(r: LedgerRecord): string {
  // Built key by key so the order is fixed and nothing outside the record format can reach the file.
  const line: LedgerRecord = {
    v: 1,
    ts: redact(r.ts),
    host: redact(r.host),
    verb: r.verb,
    tool: redact(r.tool),
    label: redactOrNull(r.label),
    credit_cost: typeof r.credit_cost === 'number' && Number.isFinite(r.credit_cost) ? r.credit_cost : null,
    budget_id: redactOrNull(r.budget_id),
    mcp_version: sanitizeMcpVersion(r.mcp_version),
    status: r.status,
  };
  return `${JSON.stringify(line)}\n`;
}

function errnoOf(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

function reasonOf(err: unknown): string {
  if (err instanceof HgiError) {
    const kind = err.details?.kind;
    if (kind === 'lock_timeout' || kind === 'lock_compromised') return kind;
    const reason = err.details?.reason;
    if (typeof reason === 'string') return reason;
    return errnoOf(err.cause) ?? (typeof kind === 'string' ? kind : 'write_failed');
  }
  return errnoOf(err) ?? 'write_failed';
}

function writeLine(file: string, buf: Buffer, lock: FileLockHandle): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      0o600,
    );
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return 'not_regular_file';
    // Exactly 0600: looser bits are removed, and a strict umask (0277, 0377) must not leave a file
    // its owner cannot reopen for the next append or for `hgi usage`.
    if ((st.mode & 0o777) !== 0o600) {
      try {
        fs.fchmodSync(fd, 0o600);
      } catch {
        return 'mode';
      }
    }
    lock.assertHeld();
    // One write of the whole line: with O_APPEND and the lock, lines never interleave.
    const written = fs.writeSync(fd, buf);
    return written === buf.length ? null : 'short_write';
  } catch (err) {
    return errnoOf(err) === 'ELOOP' ? 'symlink' : reasonOf(err);
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // nothing useful to do
      }
    }
  }
}

/** Appends one record. Never throws: returns a short reason code when the ledger was not updated. */
export async function appendLedger(file: string, record: LedgerRecord): Promise<string | null> {
  try {
    const buf = Buffer.from(serializeRecord(record), 'utf8');
    ensureDir(path.dirname(file));
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(file);
    } catch {
      st = null;
    }
    if (st?.isSymbolicLink()) return 'symlink';
    if (st && !st.isFile()) return 'not_regular_file';
    return await withFileLock(file, { label: 'ledger', retries: LEDGER_LOCK_RETRIES }, async (lock) => writeLine(file, buf, lock));
  } catch (err) {
    return reasonOf(err);
  }
}

function stderrIsJson(): boolean {
  return !process.stderr.isTTY || process.argv.includes('--json-errors');
}

/** Records a call that got a result back. Ledger trouble is one warning line, never a failure. */
export async function recordCall(file: string | null, record: LedgerRecord): Promise<void> {
  if (file === null) return;
  const reason = await appendLedger(file, record);
  if (reason === null) return;
  const safe = reason.replace(/[^A-Za-z0-9_]/g, '_');
  process.stderr.write(
    stderrIsJson()
      ? `${JSON.stringify({ warning: 'ledger_not_updated', reason: safe })}\n`
      : `hgi: warning: credit ledger not updated: ${safe}\n`,
  );
}

// ---- reading -------------------------------------------------------------------------------------

export type LedgerRead = { status: 'missing' } | { status: 'ok'; rows: LedgerRecord[]; malformed: number };

function ledgerUnsafe(reason: string, file: string): HgiError {
  return new HgiError('local_state_error', `Credit ledger path is unsafe (${reason}): ${file}`, {
    hint: 'Remove or fix it yourself; hgi will not follow symlinks or read non-regular files. Deleting the ledger only resets local history.',
    details: { kind: 'ledger_unsafe', reason },
  });
}

function readFailed(code: string, file: string, cause: unknown): HgiError {
  return new HgiError('local_state_error', `Cannot read the credit ledger ${file}: ${code}.`, {
    hint: 'Check its permissions. Deleting the ledger only resets local history.',
    details: { kind: 'read_failed', reason: code },
    cause,
  });
}

const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

function parseLine(line: string): LedgerRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const cost = r.credit_cost;
  const ok =
    r.v === 1 &&
    typeof r.ts === 'string' &&
    Number.isFinite(Date.parse(r.ts)) &&
    typeof r.host === 'string' &&
    (r.verb === 'call' || r.verb === 'run') &&
    typeof r.tool === 'string' &&
    isStringOrNull(r.label) &&
    (cost === null || (typeof cost === 'number' && Number.isFinite(cost))) &&
    isStringOrNull(r.budget_id) &&
    (r.mcp_version === null || sanitizeMcpVersion(r.mcp_version) !== null) &&
    (r.status === 'ok' || r.status === 'tool_error');
  if (!ok) return null;
  return {
    v: 1,
    ts: r.ts as string,
    host: r.host as string,
    verb: r.verb as LedgerVerb,
    tool: r.tool as string,
    label: r.label as string | null,
    credit_cost: cost as number | null,
    budget_id: r.budget_id as string | null,
    mcp_version: r.mcp_version as string | null,
    status: r.status as LedgerStatus,
  };
}

/** Reads without the lock: a torn last line is just counted as malformed. */
export function readLedger(file: string): LedgerRead {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    const code = errnoOf(err) ?? 'error';
    if (code === 'ENOENT') return { status: 'missing' };
    if (code === 'ELOOP') throw ledgerUnsafe('symlink', file);
    throw readFailed(code, file, err);
  }
  let text: string;
  try {
    if (!fs.fstatSync(fd).isFile()) throw ledgerUnsafe('not_regular_file', file);
    text = fs.readFileSync(fd, 'utf8');
  } catch (err) {
    if (err instanceof HgiError) throw err;
    throw readFailed(errnoOf(err) ?? 'error', file, err);
  } finally {
    fs.closeSync(fd);
  }
  const rows: LedgerRecord[] = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const row = parseLine(line);
    if (row) rows.push(row);
    else malformed += 1;
  }
  return { status: 'ok', rows, malformed };
}

// ---- --since, --by and the summaries --------------------------------------------------------------

function badSince(raw: string): HgiError {
  return new HgiError('invalid_input', `--since "${raw}" is not a date, a datetime, "today" or a duration.`, {
    hint: 'Use 2026-11-01, 2026-11-01T09:00 (local time unless a zone is given), today, 24h or 7d.',
    details: { reason: 'bad_since' },
  });
}

const DURATION = /^(\d+)([hd])$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/;

function validDate(y: number, m: number, d: number): boolean {
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** Epoch milliseconds for `--since`. Values without a zone are local time. */
export function parseSince(raw: string, now: number = Date.now()): number {
  const dur = DURATION.exec(raw);
  if (dur) {
    const n = Number(dur[1]);
    if (!Number.isSafeInteger(n) || n < 1) throw badSince(raw);
    return now - n * (dur[2] === 'h' ? 3_600_000 : 86_400_000);
  }
  if (raw === 'today') {
    const d = new Date(now);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
  const date = DATE.exec(raw);
  if (date) {
    const [y, m, d] = [Number(date[1]), Number(date[2]), Number(date[3])];
    if (!validDate(y, m, d)) throw badSince(raw);
    return new Date(y, m - 1, d).getTime();
  }
  const dt = DATETIME.exec(raw);
  if (dt) {
    const [y, mo, d, h, mi] = [Number(dt[1]), Number(dt[2]), Number(dt[3]), Number(dt[4]), Number(dt[5])];
    const s = dt[6] === undefined ? 0 : Number(dt[6]);
    const ms = dt[7] === undefined ? 0 : Number(dt[7].padEnd(3, '0'));
    if (!validDate(y, mo, d) || h > 23 || mi > 59 || s > 59) throw badSince(raw);
    const zone = dt[8];
    if (zone === undefined) return new Date(y, mo - 1, d, h, mi, s, ms).getTime();
    const utc = Date.UTC(y, mo - 1, d, h, mi, s, ms);
    if (zone === 'Z') return utc;
    const [zh, zm] = [Number(zone.slice(1, 3)), Number(zone.slice(4, 6))];
    if (zh > 23 || zm > 59) throw badSince(raw);
    const offset = (zh * 60 + zm) * 60_000 * (zone.startsWith('-') ? -1 : 1);
    return utc - offset;
  }
  throw badSince(raw);
}

const BY_VALUES = ['tool', 'label', 'day', 'call'] as const;
export type By = (typeof BY_VALUES)[number];
export type SummaryBy = Exclude<By, 'call'>;

export function parseBy(raw: string): By {
  if ((BY_VALUES as readonly string[]).includes(raw)) return raw as By;
  throw new HgiError('invalid_input', `--by "${raw}" is not one of: ${BY_VALUES.join(', ')}.`, {
    details: { reason: 'bad_by' },
  });
}

/** Rows for one host since a time (or all history), oldest first. */
export function filterRows(rows: LedgerRecord[], host: string, sinceMs: number | null): LedgerRecord[] {
  return rows
    .map((row) => ({ row, t: Date.parse(row.ts) }))
    .filter(({ row, t }) => row.host === host && (sinceMs === null || t >= sinceMs))
    .sort((a, b) => a.t - b.t)
    .map(({ row }) => row);
}

function localDay(ts: string): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

interface SummaryRow {
  key: string | null;
  calls: number;
  credits: number;
  zero_cost_calls: number;
  unknown_cost_calls: number;
}

function compareKeys(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/** Summary rows keyed `{[by]: key, calls, credits, zero_cost_calls, unknown_cost_calls}`. */
export function summarize(rows: LedgerRecord[], by: SummaryBy): Array<Record<string, unknown>> {
  const groups = new Map<string | null, SummaryRow>();
  for (const row of rows) {
    const key = by === 'tool' ? row.tool : by === 'label' ? row.label : localDay(row.ts);
    let g = groups.get(key);
    if (!g) {
      g = { key, calls: 0, credits: 0, zero_cost_calls: 0, unknown_cost_calls: 0 };
      groups.set(key, g);
    }
    g.calls += 1;
    if (row.credit_cost === null) g.unknown_cost_calls += 1;
    else {
      g.credits += row.credit_cost;
      if (row.credit_cost === 0) g.zero_cost_calls += 1;
    }
  }
  const list = [...groups.values()];
  if (by === 'day') list.sort((a, b) => compareKeys(a.key, b.key));
  else list.sort((a, b) => b.credits - a.credits || compareKeys(a.key, b.key));
  return list.map((g) => ({
    [by]: g.key,
    calls: g.calls,
    credits: g.credits,
    zero_cost_calls: g.zero_cost_calls,
    unknown_cost_calls: g.unknown_cost_calls,
  }));
}

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { guardLedgerOverride } from '../../src/config.js';
import {
  appendLedger,
  parseBy,
  parseLabel,
  parseSince,
  readLedger,
  sanitizeMcpVersion,
  serializeRecord,
  summarize,
  type LedgerRecord,
} from '../../src/ledger.js';
import { clearSecrets, registerSecret } from '../../src/redact.js';

const KEYS = ['v', 'ts', 'host', 'verb', 'tool', 'label', 'credit_cost', 'budget_id', 'mcp_version', 'status'];

function rec(over: Partial<LedgerRecord> = {}): LedgerRecord {
  return {
    v: 1,
    ts: '2026-11-04T17:03:12.481Z',
    host: 'phoenix.hginsights.com',
    verb: 'call',
    tool: 'company_firmographic',
    label: 'resolve',
    credit_cost: 2,
    budget_id: null,
    mcp_version: 'v2',
    status: 'ok',
    ...over,
  };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hgi-ledger-'));
});
afterEach(() => {
  clearSecrets();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('serializeRecord', () => {
  it('writes the v1 keys in order, one line, null cost kept as null', () => {
    const line = serializeRecord(rec({ credit_cost: null }));
    expect(line.endsWith('\n')).toBe(true);
    expect(line.indexOf('\n')).toBe(line.length - 1);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(KEYS);
    expect(parsed.credit_cost).toBeNull();
    expect(line).toBe(
      '{"v":1,"ts":"2026-11-04T17:03:12.481Z","host":"phoenix.hginsights.com","verb":"call","tool":"company_firmographic","label":"resolve","credit_cost":null,"budget_id":null,"mcp_version":"v2","status":"ok"}\n',
    );
  });
  it('never writes a registered secret, whichever field carries it', () => {
    const tok = 'tok_ABCDEFGHijklmnop1234';
    registerSecret(tok);
    const line = serializeRecord(rec({ label: tok, budget_id: tok, tool: tok, mcp_version: tok }));
    expect(line).not.toContain(tok);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.label).toBe('[REDACTED]');
    expect(parsed.budget_id).toBe('[REDACTED]');
    expect(parsed.tool).toBe('[REDACTED]');
    expect(parsed.mcp_version).toBeNull();
  });
});

describe('sanitizeMcpVersion', () => {
  it('keeps short plain versions and drops anything else', () => {
    expect(sanitizeMcpVersion('v2')).toBe('v2');
    expect(sanitizeMcpVersion('2025-06-18')).toBe('2025-06-18');
    expect(sanitizeMcpVersion('has space')).toBeNull();
    expect(sanitizeMcpVersion('x'.repeat(33))).toBeNull();
    expect(sanitizeMcpVersion(null)).toBeNull();
    registerSecret('secretvalue123');
    expect(sanitizeMcpVersion('secretvalue123')).toBeNull();
  });
});

describe('parseLabel / parseBy', () => {
  it('accepts the allowed characters up to 64', () => {
    expect(parseLabel('Az09._:/-')).toBe('Az09._:/-');
    expect(parseLabel('a'.repeat(64))).toBe('a'.repeat(64));
    expect(parseLabel(undefined)).toBeNull();
  });
  it.each(['has space', '', 'a'.repeat(65), 'é', 'a;b'])('refuses %j with bad_label', (raw) => {
    expect(() => parseLabel(raw)).toThrow(expect.objectContaining({ code: 'invalid_input', details: { reason: 'bad_label' } }));
  });
  it('refuses an unknown --by with bad_by', () => {
    expect(parseBy('day')).toBe('day');
    expect(() => parseBy('week')).toThrow(expect.objectContaining({ details: { reason: 'bad_by' } }));
  });
});

describe('parseSince', () => {
  const now = new Date(2026, 10, 10, 15, 30, 0).getTime(); // local 2026-11-10 15:30
  it('durations count back from now', () => {
    expect(parseSince('24h', now)).toBe(now - 24 * 3_600_000);
    expect(parseSince('7d', now)).toBe(now - 7 * 86_400_000);
  });
  it('today is local midnight', () => {
    expect(parseSince('today', now)).toBe(new Date(2026, 10, 10).getTime());
  });
  it('dates and datetimes without a zone are local; with a zone they are exact', () => {
    expect(parseSince('2026-11-01', now)).toBe(new Date(2026, 10, 1).getTime());
    expect(parseSince('2026-11-01T09:00', now)).toBe(new Date(2026, 10, 1, 9, 0).getTime());
    expect(parseSince('2026-11-01T09:00:05.5', now)).toBe(new Date(2026, 10, 1, 9, 0, 5, 500).getTime());
    expect(parseSince('2026-11-01T09:00Z', now)).toBe(Date.UTC(2026, 10, 1, 9, 0));
    expect(parseSince('2026-11-01T09:00+02:00', now)).toBe(Date.UTC(2026, 10, 1, 7, 0));
    expect(parseSince('2026-11-01T09:00-05:30', now)).toBe(Date.UTC(2026, 10, 1, 14, 30));
  });
  it.each(['yesterdayish', '0h', '2026-02-30', '2026-13-01', '2026-11-01T24:00', '7w', '', '2026-11-01T09:00+25:00'])(
    'refuses %j with bad_since',
    (raw) => {
      expect(() => parseSince(raw, now)).toThrow(expect.objectContaining({ code: 'invalid_input', details: { reason: 'bad_since' } }));
    },
  );
});

describe('summarize', () => {
  const rows = [
    rec({ tool: 'b', label: 'enrich', credit_cost: 3 }),
    rec({ tool: 'a', label: null, credit_cost: 0 }),
    rec({ tool: 'a', label: 'resolve', credit_cost: null }),
    rec({ tool: 'c', label: 'resolve', credit_cost: 3 }),
    rec({ tool: 'a', label: null, credit_cost: 1 }),
  ];
  it('by tool: sums, zero and unknown counts, credits desc then key asc', () => {
    expect(summarize(rows, 'tool')).toEqual([
      { tool: 'b', calls: 1, credits: 3, zero_cost_calls: 0, unknown_cost_calls: 0 },
      { tool: 'c', calls: 1, credits: 3, zero_cost_calls: 0, unknown_cost_calls: 0 },
      { tool: 'a', calls: 3, credits: 1, zero_cost_calls: 1, unknown_cost_calls: 1 },
    ]);
  });
  it('by label: null is its own group and sorts after named labels on a tie', () => {
    const tie = [rec({ label: null, credit_cost: 3 }), rec({ label: 'z', credit_cost: 3 })];
    expect(summarize(tie, 'label').map((r) => r.label)).toEqual(['z', null]);
    expect(summarize(rows, 'label')).toEqual([
      { label: 'enrich', calls: 1, credits: 3, zero_cost_calls: 0, unknown_cost_calls: 0 },
      { label: 'resolve', calls: 2, credits: 3, zero_cost_calls: 0, unknown_cost_calls: 1 },
      { label: null, calls: 2, credits: 1, zero_cost_calls: 1, unknown_cost_calls: 0 },
    ]);
  });
  it('by day: local dates, ascending', () => {
    const days = [
      rec({ ts: new Date(2026, 10, 3, 12).toISOString() }),
      rec({ ts: new Date(2026, 10, 1, 23, 59).toISOString() }),
      rec({ ts: new Date(2026, 10, 1, 0, 1).toISOString() }),
    ];
    expect(summarize(days, 'day').map((r) => [r.day, r.calls])).toEqual([
      ['2026-11-01', 2],
      ['2026-11-03', 1],
    ]);
  });
});

describe('readLedger', () => {
  it('reports a missing file', () => {
    expect(readLedger(path.join(dir, 'nope.jsonl'))).toEqual({ status: 'missing' });
  });
  it('skips malformed lines (torn tail, wrong types, odd mcp_version) and ignores blank ones', () => {
    const file = path.join(dir, 'ledger.jsonl');
    const good = serializeRecord(rec());
    const bad = [
      JSON.stringify({ ...rec(), credit_cost: '2' }),
      JSON.stringify({ ...rec(), v: 2 }),
      JSON.stringify({ ...rec(), mcp_version: 'has space' }),
      '[1,2]',
    ];
    fs.writeFileSync(file, `${good}\n${bad.join('\n')}\n${good}${good.slice(0, 20)}`);
    const read = readLedger(file);
    expect(read).toMatchObject({ status: 'ok', malformed: 5 });
    expect(read.status === 'ok' && read.rows).toHaveLength(2);
  });
  it('refuses a symlink and a directory with ledger_unsafe', () => {
    const target = path.join(dir, 'target.jsonl');
    fs.writeFileSync(target, serializeRecord(rec()));
    const link = path.join(dir, 'link.jsonl');
    fs.symlinkSync(target, link);
    expect(() => readLedger(link)).toThrow(expect.objectContaining({ code: 'local_state_error', details: { kind: 'ledger_unsafe', reason: 'symlink' } }));
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    expect(() => readLedger(sub)).toThrow(expect.objectContaining({ details: { kind: 'ledger_unsafe', reason: 'not_regular_file' } }));
  });
  it('an unreadable file is read_failed', () => {
    if (process.getuid?.() === 0) return;
    const file = path.join(dir, 'ledger.jsonl');
    fs.writeFileSync(file, serializeRecord(rec()), { mode: 0o000 });
    expect(() => readLedger(file)).toThrow(expect.objectContaining({ code: 'local_state_error', details: { kind: 'read_failed', reason: 'EACCES' } }));
  });
});

describe('appendLedger', () => {
  it('creates the file 0600 in a 0700 directory, one line per append', async () => {
    const file = path.join(dir, 'new', 'ledger.jsonl');
    expect(await appendLedger(file, rec())).toBeNull();
    expect(await appendLedger(file, rec({ tool: 'x' }))).toBeNull();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(file, 'utf8').trimEnd().split('\n')).toHaveLength(2);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });
  it('tightens a pre-existing 0644 ledger to 0600', async () => {
    const file = path.join(dir, 'ledger.jsonl');
    fs.writeFileSync(file, '', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    expect(await appendLedger(file, rec())).toBeNull();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
  it('a strict umask still leaves a 0600 file that later appends can reopen', async () => {
    const file = path.join(dir, 'ledger.jsonl');
    const old = process.umask(0o377);
    try {
      expect(await appendLedger(file, rec())).toBeNull();
      expect(await appendLedger(file, rec())).toBeNull();
    } finally {
      process.umask(old);
    }
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readLedger(file)).toMatchObject({ status: 'ok', malformed: 0 });
  });
  it('refuses a symlink and leaves its target untouched', async () => {
    const target = path.join(dir, 'target.txt');
    fs.writeFileSync(target, 'keep');
    const file = path.join(dir, 'ledger.jsonl');
    fs.symlinkSync(target, file);
    expect(await appendLedger(file, rec())).toBe('symlink');
    expect(fs.readFileSync(target, 'utf8')).toBe('keep');
  });
  it('gives up with lock_timeout after about 5 s when the lock is held', async () => {
    const file = path.join(dir, 'ledger.jsonl');
    fs.mkdirSync(`${file}.lock`);
    const started = Date.now();
    expect(await appendLedger(file, rec())).toBe('lock_timeout');
    const took = Date.now() - started;
    expect(took).toBeGreaterThan(3_000);
    expect(took).toBeLessThan(9_000);
    expect(fs.existsSync(file)).toBe(false);
  }, 15_000);
});

describe('guardLedgerOverride', () => {
  it('refuses a path inside the working tree, and a symlink inside it that points outside; accepts outside', () => {
    const repo = path.join(dir, 'repo');
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(repo);
    fs.mkdirSync(outside);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    fs.symlinkSync(path.join(outside, 'ledger.jsonl'), path.join(repo, 'link.jsonl'));
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      for (const p of [path.join(repo, 'ledger.jsonl'), path.join(repo, 'link.jsonl')]) {
        expect(() => guardLedgerOverride(p)).toThrow(expect.objectContaining({ details: { reason: 'workspace_guard' } }));
      }
      expect(guardLedgerOverride(path.join(outside, 'ledger.jsonl'))).toBe(path.join(outside, 'ledger.jsonl'));
    } finally {
      process.chdir(cwd);
    }
  });
});

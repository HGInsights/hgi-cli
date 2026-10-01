import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteCredentials,
  inspectCredentials,
  preflightWritable,
  readCredentials,
  withLock,
  writeCredentials,
  type Credentials,
} from '../../src/auth/credentials-store.js';
import { HgiError } from '../../src/errors.js';
import { readInputFile } from '../../src/output/out-file.js';

let dir: string;
let file: string;

const creds = (n = 1): Credentials => ({
  version: 1,
  base_url: 'https://example.test',
  client_id: 'https://example.test/.well-known/oauth-clients/hgi-cli.json',
  access_token: `access-token-${n}-xxxxxxxx`,
  refresh_token: `refresh-token-${n}-xxxxxxxx`,
  expires_at: Date.now() + 3_600_000,
  scope: 'mcp:read',
  obtained_at: Date.now(),
  user: { id: 'u', name: 'U', email: 'u@example.test' },
  organization: { slug: 'org', name: 'Org' },
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hgi-cred-'));
  file = path.join(dir, 'config', 'credentials-example.test.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function kindOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HgiError);
    return (err as HgiError).details?.kind as string;
  }
  return undefined;
}

describe('credentials file', () => {
  it('is created with mode 0600 in a 0700 directory even under a permissive umask', () => {
    const old = process.umask(0);
    try {
      writeCredentials(file, creds());
    } finally {
      process.umask(old);
    }
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
  });

  it('round-trips and replaces atomically', () => {
    writeCredentials(file, creds(1));
    writeCredentials(file, creds(2));
    expect(readCredentials(file)?.access_token).toBe('access-token-2-xxxxxxxx');
    expect(fs.readdirSync(path.dirname(file))).toHaveLength(1);
  });

  it('refuses a pre-existing symlink at the credentials path (read, preflight and write) and leaves the target alone', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const target = path.join(dir, 'victim.txt');
    fs.writeFileSync(target, 'precious');
    fs.symlinkSync(target, file);
    expect(kindOf(() => inspectCredentials(file))).toBe('credentials_unsafe');
    expect(kindOf(() => preflightWritable(file))).toBe('credentials_unsafe');
    expect(kindOf(() => writeCredentials(file, creds()))).toBe('credentials_unsafe');
    expect(fs.readFileSync(target, 'utf8')).toBe('precious');
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
  });

  it('refuses a symlinked hgi directory', () => {
    const real = path.join(dir, 'real');
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(dir, 'config'));
    expect(kindOf(() => writeCredentials(file, creds()))).toBe('credentials_unsafe');
    expect(fs.readdirSync(real)).toEqual([]);
  });

  it('refuses a non-regular file', () => {
    fs.mkdirSync(file, { recursive: true });
    expect(kindOf(() => preflightWritable(file))).toBe('credentials_unsafe');
  });

  it('distinguishes missing, corrupt and wrong-mode files', () => {
    expect(inspectCredentials(file).status).toBe('missing');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json', { mode: 0o600 });
    expect(inspectCredentials(file).status).toBe('corrupt');
    expect(kindOf(() => readCredentials(file))).toBe('credentials_corrupt');
    writeCredentials(file, creds());
    fs.chmodSync(file, 0o644);
    expect(inspectCredentials(file).status).toBe('bad_mode');
    expect(kindOf(() => readCredentials(file))).toBe('credentials_unsafe');
  });

  it('delete is idempotent', () => {
    writeCredentials(file, creds());
    deleteCredentials(file);
    deleteCredentials(file);
    expect(inspectCredentials(file).status).toBe('missing');
  });

  it('serializes concurrent read-modify-write under the lock without losing updates or leaving temp files', async () => {
    writeCredentials(file, { ...creds(), scope: '0' });
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withLock(file, async () => {
          const cur = readCredentials(file) as Credentials;
          await new Promise((r) => setTimeout(r, 15));
          writeCredentials(file, { ...cur, scope: String(Number(cur.scope) + 1) });
        }),
      ),
    );
    expect(readCredentials(file)?.scope).toBe('8');
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('lock ownership (synchronous, no timer tick needed)', () => {
  it('a newer holder stamping the owner file makes the very next write and delete fail', async () => {
    writeCredentials(file, creds());
    const results: Record<string, unknown> = {};
    await withLock(file, async (lock) => {
      fs.writeFileSync(`${file}.lock-owner`, 'someone-else');
      try {
        lock.write({ ...creds(), scope: 'overwritten' });
      } catch (err) {
        results.write = err;
      }
      try {
        lock.remove();
      } catch (err) {
        results.remove = err;
      }
    });
    expect((results.write as HgiError).details?.kind).toBe('lock_compromised');
    expect((results.remove as HgiError).details?.kind).toBe('lock_compromised');
    expect(readCredentials(file)?.scope).toBe('mcp:read');
  });
  it('a takeover AFTER the first check but before the rename is still caught (final check before commit)', async () => {
    writeCredentials(file, creds());
    let thrown: unknown;
    await withLock(file, async (lock) => {
      try {
        lock.write({ ...creds(), scope: 'overwritten' }, { afterTemp: () => fs.writeFileSync(`${file}.lock-owner`, 'a-successor') });
      } catch (err) {
        thrown = err;
      }
    });
    expect((thrown as HgiError).details?.kind).toBe('lock_compromised');
    expect(readCredentials(file)?.scope).toBe('mcp:read');
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
  it('a holder that lost ownership does not release (and so does not delete) the successor\'s lock', async () => {
    writeCredentials(file, creds());
    await withLock(file, async () => {
      fs.writeFileSync(`${file}.lock-owner`, 'a-successor');
    });
    expect(fs.existsSync(`${file}.lock`)).toBe(true);
    expect(fs.readFileSync(`${file}.lock-owner`, 'utf8')).toBe('a-successor');
    fs.rmSync(`${file}.lock`, { recursive: true, force: true });
    fs.rmSync(`${file}.lock-owner`, { force: true });
  });
  it('a FIFO at the owner path is refused instead of hanging the open, and the lock is still released', async () => {
    writeCredentials(file, creds());
    execFileSync('mkfifo', [`${file}.lock-owner`]);
    try {
      await expect(withLock(file, async () => 'unreachable')).rejects.toMatchObject({ details: { kind: 'lock_timeout' } });
      expect(fs.existsSync(`${file}.lock`)).toBe(false);
    } finally {
      fs.rmSync(`${file}.lock-owner`, { force: true });
    }
    await expect(withLock(file, async () => 'ok')).resolves.toBe('ok');
  }, 10_000);
  it('a directory at the owner path is refused with a hint, and the lock is still released', async () => {
    writeCredentials(file, creds());
    fs.mkdirSync(`${file}.lock-owner`);
    await expect(withLock(file, async () => 'unreachable')).rejects.toMatchObject({ details: { kind: 'lock_timeout' } });
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
    fs.rmdirSync(`${file}.lock-owner`);
  });
  it('the owner file is cleaned up on release and the lock is reusable', async () => {
    writeCredentials(file, creds());
    await withLock(file, async (lock) => lock.assertHeld());
    expect(fs.existsSync(`${file}.lock-owner`)).toBe(false);
    await withLock(file, async (lock) => lock.write({ ...creds(), scope: 'second' }));
    expect(readCredentials(file)?.scope).toBe('second');
  });
});

describe('lock compromise', () => {
  it('a lost lock makes the next credentials write fail instead of overwriting another process', async () => {
    writeCredentials(file, creds());
    let thrown: unknown;
    await withLock(
      file,
      async (lock) => {
        fs.rmSync(`${file}.lock`, { recursive: true, force: true });
        await new Promise((r) => setTimeout(r, 2600));
        try {
          lock.write({ ...creds(), scope: 'overwritten' });
        } catch (err) {
          thrown = err;
        }
      },
      { stale: 2000, update: 1000 },
    ).catch(() => undefined);
    expect((thrown as HgiError | undefined)?.details?.kind).toBe('lock_compromised');
    expect(readCredentials(file)?.scope).not.toBe('overwritten');
    let removed: unknown;
    await withLock(
      file,
      async (lock) => {
        fs.rmSync(`${file}.lock`, { recursive: true, force: true });
        await new Promise((r) => setTimeout(r, 2600));
        try {
          lock.remove();
        } catch (err) {
          removed = err;
        }
      },
      { stale: 2000, update: 1000 },
    ).catch(() => undefined);
    expect((removed as HgiError | undefined)?.details?.kind).toBe('lock_compromised');
    expect(readCredentials(file)).not.toBeNull();
  }, 30_000);
});

describe('readInputFile (--input @file)', () => {
  it('reads from the descriptor it checked: a swap AFTER the check cannot change what is read', () => {
    writeCredentials(file, creds());
    const innocent = path.join(dir, 'input2.json');
    fs.writeFileSync(innocent, '{"domain":"innocent.com"}');
    const text = readInputFile(innocent, [path.dirname(file)], {
      afterCheck: () => {
        fs.rmSync(innocent);
        fs.linkSync(file, innocent);
      },
    });
    expect(text).toBe('{"domain":"innocent.com"}');
    expect(text).not.toContain('access-token');
  });

  it('reads from the same descriptor it checked: swapping in a link to the credentials file between check and read is caught', () => {
    writeCredentials(file, creds());
    const innocent = path.join(dir, 'input.json');
    fs.writeFileSync(innocent, '{"domain":"a.com"}');
    expect(readInputFile(innocent, [path.dirname(file)])).toBe('{"domain":"a.com"}');

    let reason: unknown;
    try {
      readInputFile(innocent, [path.dirname(file)], {
        beforeOpen: () => {
          fs.rmSync(innocent);
          fs.linkSync(file, innocent);
        },
      });
    } catch (err) {
      reason = (err as HgiError).details?.reason;
    }
    expect(reason).toBe('protected_path');
  });
});

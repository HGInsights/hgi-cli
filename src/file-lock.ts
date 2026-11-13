import fs from 'node:fs';
import lockfile from 'proper-lockfile';
import { randomUrlSafe } from './auth/pkce.js';
import { debug } from './debug.js';
import { HgiError } from './errors.js';

export interface LockTiming {
  stale: number;
  update: number;
}

export interface LockRetries {
  retries: number;
  factor: number;
  minTimeout: number;
  maxTimeout: number;
  randomize: boolean;
}

export interface FileLockOptions {
  /** Names the lock in error messages ("credentials", "ledger"). */
  label: string;
  retries: LockRetries;
  timing?: LockTiming;
}

export interface FileLockHandle {
  assertHeld(): void;
}

/** Shared by every hgi lock, so they all agree on when a dead holder's lock may be taken over. */
const DEFAULT_TIMING: LockTiming = { stale: 30_000, update: 5_000 };

function stampOwner(ownerPath: string, nonce: string, label: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      ownerPath,
      fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      0o600,
    );
    if (!fs.fstatSync(fd).isFile()) throw new Error('not a regular file');
    fs.writeFileSync(fd, nonce);
  } catch (err) {
    throw new HgiError('local_state_error', `Could not stamp the ${label} lock (${ownerPath}): ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}.`, {
      hint: `Remove ${ownerPath} if it is not a regular file, then retry.`,
      details: { kind: 'lock_timeout' },
      cause: err,
    });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readOwner(ownerPath: string): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(ownerPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(fd).isFile()) return null;
    return fs.readFileSync(fd, 'utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Holds `<file>.lock` (proper-lockfile) while `fn` runs. The caller makes sure the parent directory exists.
 * Errors are `local_state_error` with `details.kind` `lock_timeout` (could not take it) or
 * `lock_compromised` (lost while held, from `assertHeld()`).
 */
export async function withFileLock<T>(file: string, opts: FileLockOptions, fn: (lock: FileLockHandle) => Promise<T>): Promise<T> {
  let compromised: unknown;
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(file, {
      ...DEFAULT_TIMING,
      ...(opts.timing ?? {}),
      realpath: false,
      retries: { ...opts.retries },
      onCompromised: (err) => {
        compromised = err;
        debug('lock compromised', err);
      },
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOCKED') {
      throw new HgiError('local_state_error', 'Timed out waiting for another hgi process to finish.', {
        hint: `If no other hgi is running, remove ${file}.lock and retry.`,
        details: { kind: 'lock_timeout' },
        cause: err,
      });
    }
    throw new HgiError('local_state_error', `Could not take the ${opts.label} lock: ${(err as NodeJS.ErrnoException).code ?? 'error'}.`, {
      details: { kind: 'lock_timeout' },
      cause: err,
    });
  }
  // proper-lockfile only notices a lost lock on its timer tick, so a process that stalled (a laptop
  // asleep during a refresh) could still write before the flag flips. Every holder therefore stamps a
  // nonce next to the lock on acquisition; a newer holder overwrites it, and each write or delete
  // re-reads it synchronously. (Outside the lock directory so proper-lockfile can still rmdir a stale one.)
  const ownerPath = `${file}.lock-owner`;
  const nonce = randomUrlSafe(12);
  const lost = (cause: unknown): HgiError =>
    new HgiError('local_state_error', `The ${opts.label} lock was lost while hgi was working (the process stalled for too long).`, {
      hint: 'Another hgi process may have taken over. Re-run your command.',
      details: { kind: 'lock_compromised' },
      cause,
    });
  const handle: FileLockHandle = {
    assertHeld() {
      if (compromised !== undefined) throw lost(compromised);
      if (readOwner(ownerPath) !== nonce) throw lost(new Error('lock owner changed'));
    },
  };
  let stamped = false;
  try {
    stampOwner(ownerPath, nonce, opts.label);
    stamped = true;
    return await fn(handle);
  } finally {
    // Only the current owner may unlink the owner file or release the lock: after a stall-then-takeover,
    // proper-lockfile's release() would delete the SUCCESSOR's lock directory right now. A non-owner just
    // leaves. proper-lockfile may still remove that directory at process exit if its overdue heartbeat has
    // not yet flagged the loss; that narrow case fails closed (the successor's writes are refused by the
    // owner check) and is covered by the stall-then-takeover residual in docs/security.md.
    if (!stamped) {
      await release().catch((err: unknown) => debug('lock release failed', err));
    } else if (readOwner(ownerPath) === nonce) {
      try {
        fs.unlinkSync(ownerPath);
      } catch {
        // already gone
      }
      await release().catch((err: unknown) => debug('lock release failed', err));
    } else if (compromised === undefined) {
      debug('lock ownership changed; not releasing the successor\'s lock');
    }
  }
}

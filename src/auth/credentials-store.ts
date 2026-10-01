import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { randomUrlSafe } from './pkce.js';
import { debug } from '../debug.js';
import { HgiError } from '../errors.js';
import { registerSecret } from '../redact.js';

export interface Credentials {
  version: 1;
  base_url: string;
  client_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
  obtained_at: number;
  user: { id: string; name: string | null; email: string };
  organization: { slug: string; name: string };
}

export type Inspection =
  | { status: 'missing' }
  | { status: 'ok'; creds: Credentials }
  | { status: 'corrupt' }
  | { status: 'bad_mode'; creds: Credentials };

function unsafe(reason: string, file: string): HgiError {
  return new HgiError('local_state_error', `Credentials path is unsafe (${reason}): ${file}`, {
    hint: 'Remove or fix it yourself; hgi will not follow symlinks or write to non-regular files.',
    details: { kind: 'credentials_unsafe', reason },
  });
}

function isCredentials(value: unknown): value is Credentials {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  const user = c.user as Record<string, unknown> | undefined;
  const org = c.organization as Record<string, unknown> | undefined;
  return (
    c.version === 1 &&
    typeof c.base_url === 'string' &&
    typeof c.client_id === 'string' &&
    typeof c.access_token === 'string' &&
    typeof c.refresh_token === 'string' &&
    typeof c.expires_at === 'number' &&
    typeof c.scope === 'string' &&
    typeof c.obtained_at === 'number' &&
    !!user &&
    typeof user.id === 'string' &&
    typeof user.email === 'string' &&
    !!org &&
    typeof org.slug === 'string' &&
    typeof org.name === 'string'
  );
}

export function ensureDir(dir: string): void {
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(dir);
  } catch {
    st = null;
  }
  if (st) {
    if (st.isSymbolicLink()) throw unsafe('symlink', dir);
    if (!st.isDirectory()) throw unsafe('not_a_directory', dir);
    if ((st.mode & 0o077) !== 0) {
      try {
        fs.chmodSync(dir, 0o700);
      } catch {
        // best effort: files inside are 0600 regardless
      }
    }
    return;
  }
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  } catch (err) {
    throw new HgiError('local_state_error', `Cannot create ${dir}: ${(err as NodeJS.ErrnoException).code ?? 'error'}.`, {
      details: { kind: 'write_failed' },
      cause: err,
    });
  }
}

export function preflightWritable(file: string): void {
  ensureDir(path.dirname(file));
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(file);
  } catch {
    st = null;
  }
  if (st?.isSymbolicLink()) throw unsafe('symlink', file);
  if (st && !st.isFile()) throw unsafe('not_regular_file', file);
}

export function inspectCredentials(file: string): Inspection {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { status: 'missing' };
    if (code === 'ELOOP') throw unsafe('symlink', file);
    throw new HgiError('local_state_error', `Cannot read ${file}: ${code ?? 'error'}.`, {
      details: { kind: 'credentials_unsafe', reason: code ?? 'read_failed' },
      cause: err,
    });
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw unsafe('not_regular_file', file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } catch {
      return { status: 'corrupt' };
    }
    if (!isCredentials(parsed)) return { status: 'corrupt' };
    registerSecret(parsed.access_token);
    registerSecret(parsed.refresh_token);
    if ((st.mode & 0o077) !== 0) return { status: 'bad_mode', creds: parsed };
    return { status: 'ok', creds: parsed };
  } finally {
    fs.closeSync(fd);
  }
}

export function readCredentials(file: string): Credentials | null {
  const found = inspectCredentials(file);
  switch (found.status) {
    case 'missing':
      return null;
    case 'ok':
      return found.creds;
    case 'corrupt':
      throw new HgiError('local_state_error', `Credentials file is corrupt: ${file}`, {
        hint: `Delete it and run \`hgi auth login\`.`,
        details: { kind: 'credentials_corrupt' },
      });
    case 'bad_mode':
      throw new HgiError('local_state_error', `Credentials file has unsafe permissions: ${file}`, {
        hint: `Run \`chmod 600 ${file}\`, or \`hgi auth login\` to recreate it.`,
        details: { kind: 'credentials_unsafe', reason: 'mode' },
      });
  }
}

export interface WriteHooks {
  afterTemp?: () => void;
  beforeRename?: () => void;
}

export function writePrivateFile(file: string, content: string, hooks: WriteHooks = {}): void {
  preflightWritable(file);
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      tmp,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    hooks.afterTemp?.();
    preflightWritable(file);
    hooks.beforeRename?.();
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    if (err instanceof HgiError) throw err;
    throw new HgiError('local_state_error', `Could not write ${path.basename(file)}: ${(err as NodeJS.ErrnoException).code ?? 'error'}.`, {
      details: { kind: 'write_failed' },
      cause: err,
    });
  }
}

export function writeCredentials(file: string, creds: Credentials, hooks: WriteHooks = {}): void {
  registerSecret(creds.access_token);
  registerSecret(creds.refresh_token);
  writePrivateFile(file, `${JSON.stringify(creds, null, 2)}\n`, hooks);
}

export function deleteCredentials(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

const LOCK_OPTIONS = {
  stale: 30_000,
  update: 5_000,
  realpath: false,
  retries: { retries: 60, factor: 1.4, minTimeout: 100, maxTimeout: 1_500, randomize: true },
} as const;

function stampOwner(ownerPath: string, nonce: string): void {
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
    throw new HgiError('local_state_error', `Could not stamp the credentials lock (${ownerPath}): ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}.`, {
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

export interface HeldLock {
  assertHeld(): void;
  write(creds: Credentials, hooks?: Pick<WriteHooks, 'afterTemp'>): void;
  remove(): void;
}

export interface LockTiming {
  stale: number;
  update: number;
}

export async function withLock<T>(file: string, fn: (lock: HeldLock) => Promise<T>, timing?: LockTiming): Promise<T> {
  ensureDir(path.dirname(file));
  let compromised: unknown;
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(file, {
      ...LOCK_OPTIONS,
      ...(timing ?? {}),
      retries: { ...LOCK_OPTIONS.retries },
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
    throw new HgiError('local_state_error', `Could not take the credentials lock: ${(err as NodeJS.ErrnoException).code ?? 'error'}.`, {
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
    new HgiError('local_state_error', 'The credentials lock was lost while hgi was working (the process stalled for too long).', {
      hint: 'Another hgi process may have taken over. Re-run your command.',
      details: { kind: 'lock_compromised' },
      cause,
    });
  const held: HeldLock = {
    assertHeld() {
      if (compromised !== undefined) throw lost(compromised);
      if (readOwner(ownerPath) !== nonce) throw lost(new Error('lock owner changed'));
    },
    write(creds, hooks) {
      held.assertHeld();
      writeCredentials(file, creds, { afterTemp: hooks?.afterTemp, beforeRename: () => held.assertHeld() });
    },
    remove() {
      held.assertHeld();
      deleteCredentials(file);
    },
  };
  let stamped = false;
  try {
    stampOwner(ownerPath, nonce);
    stamped = true;
    return await fn(held);
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

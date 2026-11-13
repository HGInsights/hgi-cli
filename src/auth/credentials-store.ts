import fs from 'node:fs';
import path from 'node:path';
import { HgiError } from '../errors.js';
import { registerSecret } from '../redact.js';
import { withFileLock, type LockTiming } from '../file-lock.js';

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

const LOCK_RETRIES = { retries: 60, factor: 1.4, minTimeout: 100, maxTimeout: 1_500, randomize: true } as const;

export type { LockTiming };

export interface HeldLock {
  assertHeld(): void;
  write(creds: Credentials, hooks?: Pick<WriteHooks, 'afterTemp'>): void;
  remove(): void;
}

export async function withLock<T>(
  file: string,
  fn: (lock: HeldLock) => Promise<T>,
  timing?: LockTiming,
  label = 'credentials',
): Promise<T> {
  ensureDir(path.dirname(file));
  return withFileLock(file, { label, retries: LOCK_RETRIES, timing }, (lock) => {
    const held: HeldLock = {
      assertHeld: () => lock.assertHeld(),
      write(creds, hooks) {
        lock.assertHeld();
        writeCredentials(file, creds, { afterTemp: hooks?.afterTemp, beforeRename: () => lock.assertHeld() });
      },
      remove() {
        lock.assertHeld();
        deleteCredentials(file);
      },
    };
    return fn(held);
  });
}

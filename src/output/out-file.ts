import fs from 'node:fs';
import path from 'node:path';
import { HgiError } from '../errors.js';
import { isInside, isInsideByInode, realpathDeep } from '../config.js';

export interface PathGuardOptions {
  protectedDirs: string[];
}

function refuse(message: string, reason: string, hint?: string): HgiError {
  return new HgiError('invalid_input', message, { hint, details: { reason } });
}

export function assertNotProtected(target: string, protectedDirs: string[], what: string): string {
  const real = realpathDeep(target);
  for (const dir of protectedDirs) {
    if (isInside(real, dir) || isInsideByInode(real, dir)) {
      throw refuse(`${what} may not be inside hgi's own config or cache directory.`, 'protected_path');
    }
  }
  return real;
}

function sameInode(a: fs.Stats, b: fs.Stats): boolean {
  return a.ino === b.ino && a.dev === b.dev;
}

function protectedInodes(protectedDirs: string[]): fs.Stats[] {
  const stats: fs.Stats[] = [];
  for (const dir of protectedDirs) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      try {
        const st = fs.statSync(path.join(dir, name));
        if (st.isFile()) stats.push(st);
      } catch {
        // vanished between readdir and stat
      }
    }
  }
  return stats;
}

export function readInputFile(file: string, protectedDirs: string[], hooks: { beforeOpen?: () => void; afterCheck?: () => void } = {}): string {
  const real = assertNotProtected(file, protectedDirs, '--input @file');
  let fd: number | undefined;
  try {
    hooks.beforeOpen?.();
    fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw refuse(`${file} is not a regular file.`, 'not_regular_file');
    if (protectedInodes(protectedDirs).some((other) => sameInode(st, other))) {
      throw refuse("That file is one of hgi's credential or cache files.", 'protected_path');
    }
    hooks.afterCheck?.();
    return fs.readFileSync(fd, 'utf8');
  } catch (err) {
    if (err instanceof HgiError) throw err;
    throw refuse(`Cannot read input file ${file}: ${(err as NodeJS.ErrnoException).code ?? 'error'}.`, 'input_unreadable');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export interface OutFileOptions {
  force: boolean;
  allowForce: boolean;
  protectedDirs: string[];
}

export interface OutFileCheck {
  dest: string;
  existing: boolean;
}

export function preflightOutFile(target: string, opts: OutFileOptions): OutFileCheck {
  if (opts.force && !opts.allowForce) {
    throw refuse('--force is only available on `hgi run`.', 'force_on_call', 'Use a new --out path with `hgi call`.');
  }
  const dir = realpathDeep(path.dirname(target));
  const dest = path.join(dir, path.basename(target));
  assertNotProtected(dest, opts.protectedDirs, '--out');
  try {
    if (!fs.statSync(dir).isDirectory()) throw new Error('not a directory');
    fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
  } catch {
    throw refuse(`Cannot write to ${dir}: it does not exist or is not writable.`, 'out_dir_unwritable', 'Create the directory first, or choose another --out path.');
  }

  let existing: fs.Stats | null = null;
  try {
    existing = fs.lstatSync(dest);
  } catch {
    existing = null;
  }
  if (existing) {
    if (existing.isSymbolicLink()) throw refuse(`Refusing to write through symlink ${dest}.`, 'symlink');
    if (!existing.isFile()) throw refuse(`${dest} is not a regular file.`, 'not_regular_file');
    if (!opts.force) {
      throw refuse(`${dest} already exists.`, 'out_exists', 'Choose a new path, or pass --force to `hgi run`.');
    }
  }
  return { dest, existing: existing !== null };
}

export function writeOutFile(target: string, data: string, opts: OutFileOptions): void {
  const { dest, existing } = preflightOutFile(target, opts);
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW;
  const tmp = existing ? `${dest}.hgi-${process.pid}-${Date.now()}.tmp` : dest;
  try {
    const fd = fs.openSync(tmp, flags, 0o666);
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (existing) fs.renameSync(tmp, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST' && !existing) {
      throw refuse(`${dest} already exists.`, 'out_exists', 'Choose a new path, or pass --force to `hgi run`.');
    }
    throw new HgiError('local_state_error', `Could not write ${dest}: ${(err as NodeJS.ErrnoException).code ?? 'error'}.`, {
      details: { kind: 'write_failed' },
      cause: err,
    });
  }
}

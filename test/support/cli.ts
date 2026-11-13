import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BIN = path.resolve(here, '../../dist/bin.js');
/** When set, every spawn runs this packaged binary instead of `node dist/bin.js`. */
export const HGI_BIN = process.env.HGI_BIN ? path.resolve(process.env.HGI_BIN) : null;

export function hgiCommand(): { command: string; prefix: string[] } {
  return HGI_BIN ? { command: HGI_BIN, prefix: [] } : { command: process.execPath, prefix: [BIN] };
}

/** The same command as a string, for tests that pipe it through `sh -c`. */
export function hgiShellCommand(): string {
  const { command, prefix } = hgiCommand();
  return [command, ...prefix].join(' ');
}

export const BROWSER_SCRIPT = path.resolve(here, 'browser.mjs');

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface Sandbox {
  dir: string;
  configDir: string;
  cacheDir: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

export function makeSandbox(base: string, extra: NodeJS.ProcessEnv = {}): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hgi-test-'));
  const configDir = path.join(dir, 'config');
  const cacheDir = path.join(dir, 'cache');
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: dir,
    HGI_BASE_URL: base,
    HGI_CONFIG_DIR: configDir,
    HGI_CACHE_DIR: cacheDir,
    BROWSER: `${process.execPath} ${BROWSER_SCRIPT}`,
    NO_PROXY: '127.0.0.1,localhost',
    ...extra,
  };
  return { dir, configDir, cacheDir, env, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export function runCli(args: string[], env: NodeJS.ProcessEnv, opts: { input?: string; timeoutMs?: number; cwd?: string } = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const { command, prefix } = hgiCommand();
    const child = spawn(command, [...prefix, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'], cwd: opts.cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`hgi ${args.join(' ')} timed out\nstdout=${stdout}\nstderr=${stderr}`));
    }, opts.timeoutMs ?? 40_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(opts.input ?? '');
  });
}

export function credentialsFile(sandbox: Sandbox): string {
  const files = fs.readdirSync(sandbox.configDir).filter((f) => f.startsWith('credentials-') && f.endsWith('.json'));
  if (files.length !== 1) throw new Error(`expected one credentials file, found ${files.join(',')}`);
  return path.join(sandbox.configDir, files[0] as string);
}

export function readCreds(sandbox: Sandbox): { access_token: string; refresh_token: string; expires_at: number } {
  return JSON.parse(fs.readFileSync(credentialsFile(sandbox), 'utf8')) as {
    access_token: string;
    refresh_token: string;
    expires_at: number;
  };
}

export interface LiveCli {
  child: ReturnType<typeof spawn>;
  waitForStderr(pattern: RegExp, timeoutMs?: number): Promise<string>;
  waitForStdout(pattern: RegExp, timeoutMs?: number): Promise<string>;
  write(text: string): void;
  result(): Promise<CliResult>;
}

export function startCli(args: string[], env: NodeJS.ProcessEnv): LiveCli {
  const { command, prefix } = hgiCommand();
  const child = spawn(command, [...prefix, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const watchers: Array<() => void> = [];
  child.stdout?.on('data', (d: Buffer) => {
    stdout += d.toString();
    watchers.forEach((w) => w());
  });
  child.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString();
    watchers.forEach((w) => w());
  });
  const closed = new Promise<CliResult>((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
  const waitFor =
    (read: () => string, name: string) =>
    (pattern: RegExp, timeoutMs = 15_000): Promise<string> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${pattern} on ${name}; stdout=${stdout} stderr=${stderr}`)), timeoutMs);
        const check = () => {
          const m = pattern.exec(read());
          if (m) {
            clearTimeout(timer);
            resolve(m[1] ?? m[0]);
          }
        };
        watchers.push(check);
        check();
      });
  return {
    child,
    waitForStderr: waitFor(() => stderr, 'stderr'),
    waitForStdout: waitFor(() => stdout, 'stdout'),
    write: (text) => child.stdin?.write(text),
    result: () => closed,
  };
}

/**
 * Runs hgi with stdout and stderr on a pseudo-terminal, through script(1). Returns null when script(1) is missing.
 * The PTY merges both streams into `stdout`.
 */
export async function runCliInPty(args: string[], env: NodeJS.ProcessEnv): Promise<CliResult | null> {
  const { command, prefix } = hgiCommand();
  const quote = (s: string) => `'${s.split("'").join(`'"'"'`)}'`;
  const line = [command, ...prefix, ...args].map(quote).join(' ');
  const scriptArgs = process.platform === 'darwin' ? ['-q', '/dev/null', 'sh', '-c', line] : ['-qec', line, '/dev/null'];
  return new Promise((resolve, reject) => {
    const child = spawn('script', scriptArgs, { env: { ...env, TERM: 'dumb' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? resolve(null) : reject(err)));
    const timer = setTimeout(() => child.kill('SIGKILL'), 40_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.split('\r\n').join('\n'), stderr });
    });
  });
}

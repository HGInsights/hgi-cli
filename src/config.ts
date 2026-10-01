import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HgiError } from './errors.js';

declare const __HGI_VERSION__: string;

export const VERSION: string =
  typeof __HGI_VERSION__ !== 'undefined' ? __HGI_VERSION__ : '0.0.0-dev';

export const DEFAULT_BASE_URL = 'https://phoenix.hginsights.com';
export const MCP_PATH = '/api/ai/mcp';
export const SCOPE = 'mcp:read mcp:tools offline_access';

// The listener binds 127.0.0.1 only, but the redirect URI names `localhost`: the front door (AWS ALB/WAF)
// answers 403 to any request whose query string contains the literal 127.0.0.1, which would block the
// consent page. The client metadata document registers both http://localhost/callback and
// http://127.0.0.1/callback (any port).
export const LOOPBACK_REDIRECT_HOST = 'localhost';
export const USER_AGENT = `hgi/${VERSION}`;

type Env = NodeJS.ProcessEnv;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function resolveBaseUrl(raw: string | undefined | null): string {
  const value = (raw ?? '').trim() || DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HgiError('invalid_input', `Invalid base URL: ${value}`, {
      hint: 'Set HGI_BASE_URL to an origin such as https://phoenix.hginsights.com.',
      details: { reason: 'invalid_base_url' },
    });
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  const httpsOk = url.protocol === 'https:';
  const httpLoopbackOk = url.protocol === 'http:' && loopback;
  if (!httpsOk && !httpLoopbackOk) {
    throw new HgiError('invalid_input', `Base URL must use https (got ${url.protocol}//).`, {
      hint: 'Plain http is only allowed for loopback hosts used in tests.',
      details: { reason: 'insecure_base_url' },
    });
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new HgiError('invalid_input', 'Base URL must be an origin with no path, query or credentials.', {
      details: { reason: 'invalid_base_url' },
    });
  }
  return url.origin;
}

export function mcpUrl(base: string): string {
  return `${base}${MCP_PATH}`;
}

export function clientId(base: string): string {
  return `${base}/.well-known/oauth-clients/hgi-cli.json`;
}

export function hostSlug(base: string): string {
  const url = new URL(base);
  const host = url.hostname.replace(/[^a-z0-9.-]/gi, '_').toLowerCase();
  return url.port ? `${host}-${url.port}` : host;
}

export function realpathDeep(target: string): string {
  const resolved = path.resolve(target);
  const rest: string[] = [];
  let cur = resolved;
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return path.join(real, ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return resolved;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function isInsideByInode(child: string, parent: string): boolean {
  let parentStat: fs.Stats;
  try {
    parentStat = fs.statSync(parent);
  } catch {
    return false;
  }
  let cur = path.resolve(child);
  for (;;) {
    try {
      const st = fs.statSync(cur);
      if (st.ino === parentStat.ino && st.dev === parentStat.dev) return true;
    } catch {
      // ancestor does not exist yet; keep walking up
    }
    const up = path.dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
}

function workspaceRoot(): string | null {
  const home = realpathDeep(os.homedir());
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    timeout: 2000,
  });
  if (res.status !== 0 || !res.stdout) return null;
  const top = realpathDeep(res.stdout.trim());
  if (top === home || top === path.parse(top).root) return null;
  return top;
}

function guardOverride(dir: string, label: string): string {
  const resolved = realpathDeep(dir);
  const root = workspaceRoot();
  if (root && (isInside(resolved, root) || isInsideByInode(resolved, root))) {
    throw new HgiError('invalid_input', `${label} must not be inside a workspace (${root}).`, {
      hint: 'Credentials and caches never live in a project directory; choose a path outside it.',
      details: { reason: 'workspace_guard' },
    });
  }
  return path.resolve(dir);
}

export function configDir(env: Env = process.env): string {
  if (env.HGI_CONFIG_DIR) return guardOverride(env.HGI_CONFIG_DIR, 'HGI_CONFIG_DIR');
  if (env.XDG_CONFIG_HOME) return guardOverride(path.join(env.XDG_CONFIG_HOME, 'hgi'), 'XDG_CONFIG_HOME');
  return path.join(os.homedir(), '.config', 'hgi');
}

export function cacheDir(env: Env = process.env): string {
  if (env.HGI_CACHE_DIR) return guardOverride(env.HGI_CACHE_DIR, 'HGI_CACHE_DIR');
  if (env.XDG_CACHE_HOME) return guardOverride(path.join(env.XDG_CACHE_HOME, 'hgi'), 'XDG_CACHE_HOME');
  return path.join(os.homedir(), '.cache', 'hgi');
}

export function credentialsPath(base: string, env: Env = process.env): string {
  return path.join(configDir(env), `credentials-${hostSlug(base)}.json`);
}

export function protectedDirs(env: Env = process.env): string[] {
  return [realpathDeep(configDir(env)), realpathDeep(cacheDir(env))];
}

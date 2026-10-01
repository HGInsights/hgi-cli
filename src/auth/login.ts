import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { clientId, LOOPBACK_REDIRECT_HOST, SCOPE } from '../config.js';
import { debug } from '../debug.js';
import { HgiError, toHgiError } from '../errors.js';
import { registerSecret } from '../redact.js';
import { httpRequest, sleep } from '../http.js';
import {
  inspectCredentials,
  preflightWritable,
  withLock,
  type Credentials,
} from './credentials-store.js';
import { parsePastedCallback } from './callback.js';
import { startLoopback } from './loopback.js';
import {
  buildAuthorizeUrl,
  discover,
  exchangeCode,
  getUserinfo,
  revokeToken,
  type AsMetadata,
  type TokenSet,
  type Userinfo,
} from './oauth-client.js';
import { challengeS256, randomUrlSafe } from './pkce.js';
import { computeDeadline } from './token-manager.js';

const LOGIN_TIMEOUT_MS = 5 * 60_000;

export interface LoginOptions {
  base: string;
  credPath: string;
  noBrowser: boolean;
  say: (line: string) => void;
}

export interface LoginResult {
  base_url: string;
  user: Userinfo['user'];
  organization: Userinfo['organization'];
  client: Userinfo['client'];
}

function openBrowser(url: string): void {
  const custom = process.env.BROWSER;
  let cmd: string;
  let args: string[];
  if (custom) {
    [cmd = custom, ...args] = custom.split(/\s+/).filter(Boolean);
    args.push(url);
  } else if (process.platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', (err) => debug('could not open browser', err.message));
    child.unref();
  } catch (err) {
    debug('could not open browser', err);
  }
}

function readPastedLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  process.stderr.write(prompt);
  let answered = false;
  return new Promise((resolve, reject) => {
    rl.once('line', (line) => {
      answered = true;
      process.stderr.write('\n');
      resolve(line);
      rl.close();
    });
    rl.once('close', () => {
      if (answered) return;
      process.stderr.write('\n');
      reject(
        new HgiError('oauth_error', 'No callback URL was provided on stdin.', {
          details: { reason: 'no_callback' },
        }),
      );
    });
  });
}

async function userinfoForLogin(meta: AsMetadata, accessToken: string): Promise<Userinfo> {
  const fetchOnce = () =>
    getUserinfo(
      meta,
      (url) => httpRequest(url, { headers: { Authorization: `Bearer ${accessToken}` } }, { redirectKind: 'oauth', context: 'the userinfo endpoint' }),
      'oauth',
    );
  try {
    return await fetchOnce();
  } catch (err) {
    const retry = err instanceof HgiError && err.code === 'server_unreachable' ? err.details?.retry_after_seconds : undefined;
    if (err instanceof HgiError && err.code === 'server_unreachable' && err.details?.status === 503) {
      await sleep(Math.min(typeof retry === 'number' ? retry : 5, 5) * 1000);
      return fetchOnce();
    }
    throw err;
  }
}

async function revokePair(
  meta: AsMetadata,
  base: string,
  pair: { accessToken: string; refreshToken: string },
): Promise<boolean> {
  try {
    await revokeToken(meta, base, pair.refreshToken, 'refresh_token');
    await revokeToken(meta, base, pair.accessToken, 'access_token');
    return true;
  } catch (err) {
    debug('revoke failed', err);
    return false;
  }
}

export async function login(opts: LoginOptions): Promise<LoginResult> {
  const { base, credPath, say } = opts;
  preflightWritable(credPath);
  const meta = await discover(base);

  const verifier = randomUrlSafe(32);
  registerSecret(verifier);
  const state = randomUrlSafe(16);
  const challenge = challengeS256(verifier);

  let code: string;
  let redirectUri: string;

  if (opts.noBrowser) {
    const port = 49152 + Math.floor(Math.random() * (65535 - 49152));
    redirectUri = `http://${LOOPBACK_REDIRECT_HOST}:${port}/callback`;
    const url = buildAuthorizeUrl(meta, base, { redirectUri, state, challenge });
    say('Open this URL in a browser on any machine and approve access:');
    say(`  ${url}`);
    say('After approving, the browser will fail to load a http://localhost page. Copy that full URL from the address bar.');
    const pasted = await readPastedLine('Paste the callback URL: ');
    code = parsePastedCallback(pasted, { redirectUri, state }, { value: false });
  } else {
    const loop = await startLoopback({ state, timeoutMs: LOGIN_TIMEOUT_MS });
    try {
      redirectUri = loop.redirectUri;
      const url = buildAuthorizeUrl(meta, base, { redirectUri, state, challenge });
      say('Opening your browser to sign in. If it does not open, visit:');
      say(`  ${url}`);
      openBrowser(url);
      code = await loop.waitForCode();
    } finally {
      loop.close();
    }
  }

  const tokens = await exchangeCode(meta, base, { code, verifier, redirectUri });
  const newPair = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };

  let info: Userinfo;
  let oldPair: { accessToken: string; refreshToken: string } | null = null;
  let replaced: 'corrupt' | 'bad_mode' | null = null;
  try {
    info = await userinfoForLogin(meta, tokens.accessToken);
    oldPair = await withLock(credPath, async (lock) => {
      const existing = inspectCredentials(credPath);
      if (existing.status === 'corrupt' || existing.status === 'bad_mode') replaced = existing.status;
      lock.write(toCredentials(base, tokens, info));
      if (existing.status === 'ok' || existing.status === 'bad_mode') {
        return { accessToken: existing.creds.access_token, refreshToken: existing.creds.refresh_token };
      }
      return null;
    });
  } catch (err) {
    const revoked = await revokePair(meta, base, newPair);
    if (!revoked) {
      say('warning: the new session could not be revoked and may stay valid for up to 30 days.');
    }
    throw toHgiError(err);
  }

  if (replaced === 'corrupt') say('warning: replaced an unreadable credentials file; any older session could not be revoked.');
  if (replaced === 'bad_mode') say('warning: the previous credentials file was readable by other users; it has been replaced and the old session revoked.');
  if (oldPair && !(await revokePair(meta, base, oldPair))) {
    say('warning: the previous session was not revoked and may stay valid for up to 30 days.');
  }

  return { base_url: base, user: info.user, organization: info.organization, client: info.client };
}

function toCredentials(base: string, tokens: TokenSet, info: Userinfo): Credentials {
  return {
    version: 1,
    base_url: base,
    client_id: clientId(base),
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expires_at: computeDeadline(tokens),
    scope: tokens.scope || SCOPE,
    obtained_at: tokens.receivedAt,
    user: info.user,
    organization: info.organization,
  };
}


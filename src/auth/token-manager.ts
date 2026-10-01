import { HgiError, LOGIN_HINT } from '../errors.js';
import { debug } from '../debug.js';
import { discover, refreshTokens, revokeToken, type TokenSet } from './oauth-client.js';
import { readCredentials, withLock, type Credentials } from './credentials-store.js';

export const EXPIRY_MARGIN_MS = 60_000;

export function computeDeadline(tokens: Pick<TokenSet, 'receivedAt' | 'expiresIn'>): number {
  return tokens.receivedAt + tokens.expiresIn * 1000 - EXPIRY_MARGIN_MS;
}

export function loginRequired(): HgiError {
  return new HgiError('login_required', 'You are not signed in.', { hint: LOGIN_HINT });
}

export interface TokenManagerOptions {
  base: string;
  credPath: string;
  now?: () => number;
}

export class TokenManager {
  readonly base: string;
  readonly credPath: string;
  private readonly now: () => number;

  constructor(opts: TokenManagerOptions) {
    this.base = opts.base;
    this.credPath = opts.credPath;
    this.now = opts.now ?? Date.now;
  }

  loadCredentials(): Credentials {
    const creds = readCredentials(this.credPath);
    if (!creds) throw loginRequired();
    if (creds.base_url !== this.base) {
      throw new HgiError('login_required', `Stored credentials are for ${creds.base_url}, not ${this.base}.`, {
        hint: LOGIN_HINT,
      });
    }
    return creds;
  }

  async getAccessToken(): Promise<string> {
    const creds = this.loadCredentials();
    if (creds.expires_at > this.now()) return creds.access_token;
    return this.refreshUnderLock(creds.access_token);
  }

  forceRefresh(staleAccessToken: string): Promise<string> {
    return this.refreshUnderLock(staleAccessToken);
  }

  private refreshUnderLock(heldAccessToken: string): Promise<string> {
    return withLock(this.credPath, async (lock) => {
      const onDisk = this.loadCredentials();
      if (onDisk.access_token !== heldAccessToken && onDisk.expires_at > this.now()) {
        return onDisk.access_token;
      }
      const meta = await discover(this.base);
      const tokens = await refreshTokens(meta, this.base, onDisk.refresh_token, this.now);
      const next: Credentials = {
        ...onDisk,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_at: computeDeadline(tokens),
        scope: tokens.scope || onDisk.scope,
        obtained_at: tokens.receivedAt,
      };
      try {
        lock.write(next);
      } catch (err) {
        if (err instanceof HgiError && err.details?.kind === 'lock_compromised') {
          // The server already rotated the session; with nowhere to save it, kill the orphan (it is its own
          // row, so another process's session is untouched). The re-run then reads whatever the new holder saved.
          await revokeToken(meta, this.base, tokens.refreshToken, 'refresh_token').catch((e: unknown) => debug('orphan revoke failed', e));
          await revokeToken(meta, this.base, tokens.accessToken, 'access_token').catch((e: unknown) => debug('orphan revoke failed', e));
        }
        throw err;
      }
      return next.access_token;
    });
  }
}

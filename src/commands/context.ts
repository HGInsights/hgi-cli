import type { Command } from 'commander';
import { TokenManager } from '../auth/token-manager.js';
import { createAuthedFetch, type AuthedFetch } from '../authed-fetch.js';
import { credentialsPath, resolveBaseUrl } from '../config.js';
import { setDebug } from '../debug.js';

export interface CommandContext {
  base: string;
  credPath: string;
  tokens: TokenManager;
  authedFetch: AuthedFetch;
}

export function buildContext(cmd: Command): CommandContext {
  const globals = cmd.optsWithGlobals<{ baseUrl?: string; debug?: boolean }>();
  setDebug(Boolean(globals.debug) || process.env.HGI_DEBUG === '1');
  const base = resolveBaseUrl(globals.baseUrl ?? process.env.HGI_BASE_URL);
  const credPath = credentialsPath(base);
  const tokens = new TokenManager({ base, credPath });
  return { base, credPath, tokens, authedFetch: createAuthedFetch(tokens, base) };
}

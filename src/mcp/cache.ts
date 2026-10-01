import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { cacheDir, hostSlug } from '../config.js';
import { debug } from '../debug.js';
import { writePrivateFile } from '../auth/credentials-store.js';
import type { McpTool } from './tools.js';

export const TOOLS_CACHE_TTL_MS = 15 * 60_000;

export interface ToolsCache {
  fetched_at: number;
  mcp_version: string | null;
  server: { name?: string; version?: string } | null;
  tools: McpTool[];
}

export function toolsCachePath(base: string, orgSlug: string, userId: string): string {
  const userHash = createHash('sha256').update(userId).digest('hex').slice(0, 12);
  const org = orgSlug.replace(/[^a-z0-9_-]/gi, '_');
  return path.join(cacheDir(), `tools-${hostSlug(base)}-${org}-${userHash}.json`);
}

export function readToolsCache(file: string, now = Date.now()): ToolsCache | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as ToolsCache;
    if (!Array.isArray(parsed.tools) || typeof parsed.fetched_at !== 'number') return null;
    if (now - parsed.fetched_at > TOOLS_CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeToolsCache(file: string, cache: ToolsCache): void {
  try {
    writePrivateFile(file, JSON.stringify(cache));
  } catch (err) {
    debug('could not write tools cache', err);
  }
}

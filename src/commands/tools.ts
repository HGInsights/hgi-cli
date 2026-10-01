import type { Command } from 'commander';
import type { Credentials } from '../auth/credentials-store.js';
import { toolsCachePath, readToolsCache, writeToolsCache, type ToolsCache } from '../mcp/cache.js';
import { openSession } from '../mcp/session.js';
import { summarize } from '../mcp/tools.js';
import { defaultFormat, parseFormat } from '../output/format.js';
import { buildContext } from './context.js';
import { emit, preflightOutput } from './emit.js';
import { parseTimeoutMs } from './invoke.js';

export function mcpCacheKey(base: string, creds: Credentials): [string, string, string] {
  return [base, creds.organization.slug, creds.user.id];
}

function shortDescription(text: string): string {
  const line = text.split(/\r\n|\r|\n/)[0] ?? '';
  return line.length > 100 ? `${line.slice(0, 97)}...` : line;
}

export function registerToolsCommands(program: Command): void {
  const tools = program.command('tools').description('Discover what the server offers you');

  tools
    .command('list')
    .description('List the tools the authenticated server offers, marked call or run')
    .option('--refresh', 'ignore the local cache and ask the server')
    .option('--json', 'shorthand for -f json')
    .option('-f, --format <format>', 'json|jsonl|csv|yaml|table')
    .option('--select <fields>', 'keep only these comma-separated fields')
    .option('--out <file>', 'write to a new file instead of stdout')
    .option('--timeout <seconds>', 'per-request timeout', '120')
    .action(async (opts: { refresh?: boolean; json?: boolean; format?: string; select?: string; out?: string; timeout: string }, cmd: Command) => {
      preflightOutput({ format: opts.json ? 'json' : opts.format, select: opts.select, out: opts.out });
      const timeoutMs = parseTimeoutMs(opts.timeout);
      const ctx = buildContext(cmd);
      const creds = ctx.tokens.loadCredentials();
      const cachePath = toolsCachePath(...mcpCacheKey(ctx.base, creds));

      let data: ToolsCache | null = opts.refresh ? null : readToolsCache(cachePath);
      const fromCache = data !== null;
      if (!data) {
        const session = await openSession(ctx, { timeoutMs });
        try {
          const list = await session.listTools();
          data = {
            fetched_at: Date.now(),
            mcp_version: session.state.mcpVersion,
            server: session.serverInfo,
            tools: list,
          };
        } finally {
          await session.close();
        }
        writeToolsCache(cachePath, data);
      }

      const format = opts.json ? 'json' : opts.format ? parseFormat(opts.format) : defaultFormat(Boolean(process.stdout.isTTY));
      const summaries = data.tools.map(summarize);
      let value: unknown;
      if (format === 'table' || format === 'csv') {
        value = summaries.map((s) => ({
          name: s.name,
          verb: s.verb,
          required: s.required.join(','),
          description: format === 'table' ? shortDescription(s.description) : s.description,
        }));
        process.stderr.write(`mcp_version: ${data.mcp_version ?? 'unknown'}\n`);
      } else {
        value = {
          base_url: ctx.base,
          mcp_version: data.mcp_version,
          server: data.server,
          fetched_at: new Date(data.fetched_at).toISOString(),
          from_cache: fromCache,
          count: summaries.length,
          tools: summaries,
        };
      }
      await emit(value, { format, select: opts.select, out: opts.out });
    });
}

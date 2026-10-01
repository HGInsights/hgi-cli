import { Option, type Command } from 'commander';
import { protectedDirs } from '../config.js';
import { HgiError, toHgiError } from '../errors.js';
import { readInputFile } from '../output/out-file.js';
import { mcpCacheKey } from './tools.js';
import { toolsCachePath, writeToolsCache } from '../mcp/cache.js';
import { interpretResult } from '../mcp/result.js';
import { openSession } from '../mcp/session.js';
import { verbFor, type McpTool, type Verb } from '../mcp/tools.js';
import { assertValidInput } from '../mcp/validate.js';
import { buildContext } from './context.js';
import { applySelect } from '../output/select.js';
import { emit, preflightOutput } from './emit.js';

interface InvokeOptions {
  input?: string;
  format?: string;
  select?: string;
  out?: string;
  force?: boolean;
  meta?: boolean;
  validate: boolean;
  timeout: string;
}

export function parseTimeoutMs(raw: string): number {
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new HgiError('invalid_input', '--timeout must be a positive number of seconds.', {
      details: { reason: 'bad_timeout' },
    });
  }
  return seconds * 1000;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

export async function readInput(raw: string | undefined): Promise<Record<string, unknown>> {
  if (raw === undefined) return {};
  let text = raw;
  if (raw === '-') text = await readStdin();
  else if (raw.startsWith('@')) text = readInputFile(raw.slice(1), protectedDirs());
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HgiError('invalid_input', '--input is not valid JSON.', {
      hint: 'Pass a JSON object, e.g. --input \'{"domain":"example.com"}\'. Use @file or - to read from a file or stdin.',
      details: { reason: 'invalid_json' },
    });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HgiError('invalid_input', '--input must be a JSON object.', { details: { reason: 'input_not_object' } });
  }
  return parsed as Record<string, unknown>;
}

function suggest(name: string, tools: McpTool[]): string[] {
  const needle = name.toLowerCase();
  return tools
    .map((t) => t.name)
    .filter((n) => n.toLowerCase().includes(needle) || needle.includes(n.toLowerCase()))
    .slice(0, 5);
}

function reportCredit(cost: number | null): void {
  const json = !process.stderr.isTTY || process.argv.includes('--json-errors');
  process.stderr.write(json ? `${JSON.stringify({ credit_cost: cost })}\n` : `credit_cost: ${cost ?? 'unknown'}\n`);
}

export function assertVerb(requested: Verb, tool: McpTool): void {
  const expected = verbFor(tool);
  if (requested === expected) return;
  const why =
    expected === 'run'
      ? 'it changes state or starts work (or does not declare itself read-only)'
      : 'it is read-only';
  throw new HgiError('wrong_verb', `${tool.name} must be run with \`hgi ${expected}\`: ${why}.`, {
    hint: `Use: hgi ${expected} ${tool.name} --input '<json>'. Nothing was sent.`,
    details: { tool: tool.name, expected_verb: expected, requested_verb: requested },
  });
}

async function runInvoke(verb: Verb, toolName: string, opts: InvokeOptions, cmd: Command): Promise<void> {
  const input = await readInput(opts.input);
  preflightOutput({ format: opts.format, select: opts.select, out: opts.out, force: opts.force, allowForce: verb === 'run' });
  const timeoutMs = parseTimeoutMs(opts.timeout);
  const ctx = buildContext(cmd);
  const creds = ctx.tokens.loadCredentials();
  const session = await openSession(ctx, { timeoutMs });
  try {
    const tools = await session.listTools();
    writeToolsCache(toolsCachePath(...mcpCacheKey(ctx.base, creds)), {
      fetched_at: Date.now(),
      mcp_version: session.state.mcpVersion,
      server: session.serverInfo,
      tools,
    });
    const tool = tools.find((t) => t.name === toolName);
    if (!tool) {
      const near = suggest(toolName, tools);
      throw new HgiError('invalid_input', `Unknown tool "${toolName}".`, {
        hint: near.length ? `Did you mean: ${near.join(', ')}? Run \`hgi tools list\` for everything available.` : 'Run `hgi tools list` for everything available.',
        details: { reason: 'unknown_tool', tool: toolName, ...(near.length ? { suggestions: near } : {}) },
      });
    }
    assertVerb(verb, tool);
    if (opts.validate) assertValidInput(tool, input);

    const result = await session.callTool(toolName, input);
    const outcome = interpretResult(result, toolName);
    const selected = applySelect(outcome.value, opts.select);
    const value = opts.meta
      ? { result: selected, credit_cost: outcome.creditCost, mcp_version: session.state.mcpVersion }
      : selected;
    try {
      await emit(value, {
        format: opts.format,
        out: opts.out,
        force: opts.force,
        allowForce: verb === 'run',
      });
    } catch (err) {
      if (!opts.out) throw err;
      const cause = toHgiError(err);
      try {
        await emit(value, { format: opts.format });
      } catch {
        // stdout is gone too; the tool still ran, so keep the error below
      }
      throw new HgiError('local_state_error', `The tool ran, but its result could not be written to ${opts.out}: ${cause.message}`, {
        hint: 'The tool already ran and was billed; its result was printed to stdout instead. Do NOT re-run it.',
        details: { kind: 'write_failed', reason: cause.details?.reason ?? cause.code, tool_ran: true },
        cause: err,
      });
    } finally {
      reportCredit(outcome.creditCost);
    }
  } finally {
    await session.close();
  }
}

export function registerInvokeCommands(program: Command): void {
  const describeVerb: Record<Verb, string> = {
    call: 'Run a read-only tool (lookups). Fails for tools that change state.',
    run: 'Run a tool that changes state or starts work. Fails for read-only tools.',
  };
  for (const verb of ['call', 'run'] as const) {
    program
      .command(`${verb} <tool>`)
      .description(describeVerb[verb])
      .option('--input <json>', 'tool arguments as a JSON object; @file or - reads a file or stdin')
      .option('-f, --format <format>', 'json|jsonl|csv|yaml|table')
      .option('--select <fields>', 'keep only these comma-separated fields (dotted paths allowed)')
      .option('--out <file>', 'write the result to a new file instead of stdout')
      .option('--force', verb === 'run' ? 'overwrite an existing --out file' : 'not available on call')
      .option('--meta', 'print {result, credit_cost, mcp_version} instead of the bare result')
      .option('--timeout <seconds>', 'per-request timeout', '120')
      .addOption(new Option('--no-validate', 'skip client-side schema validation (let the server judge the input)').hideHelp())
      .action((tool: string, opts: InvokeOptions, cmd: Command) => runInvoke(verb, tool, opts, cmd));
  }
}

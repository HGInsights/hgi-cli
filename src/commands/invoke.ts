import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Option, type Command } from 'commander';
import { protectedDirs } from '../config.js';
import { HgiError, toHgiError } from '../errors.js';
import { readInputFile } from '../output/out-file.js';
import { mcpCacheKey } from './tools.js';
import { toolsCachePath, writeToolsCache } from '../mcp/cache.js';
import { budgetId as ledgerBudgetId, ledgerPath, parseLabel, recordCall } from '../ledger.js';
import { checkBudget, recordSpend, resolveBudgetId, resolveMaxCredits } from '../budget.js';
import { creditCostOf, interpretResult } from '../mcp/result.js';
import { openSession } from '../mcp/session.js';
import { verbFor, type McpTool, type Verb } from '../mcp/tools.js';
import { assertValidInput } from '../mcp/validate.js';
import { buildContext } from './context.js';
import { applySelect } from '../output/select.js';
import { emit, preflightOutput } from './emit.js';
import { preflightBatchFlags, readIds, runBatch } from './batch.js';
import { readStdin, reportCredit } from './io.js';

interface InvokeOptions {
  input?: string;
  format?: string;
  select?: string;
  out?: string;
  force?: boolean;
  meta?: boolean;
  label?: string;
  validate: boolean;
  timeout: string;
  maxCredits?: string;
  ids?: string;
  idsColumn?: string;
  batchSize?: string;
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

/** The tool ran, but its spend could not be recorded: print the result to stdout (never only to --out), then exit 12. */
async function failAfterBudgetWrite(cause: HgiError, value: unknown, opts: InvokeOptions, creditCost: number | null): Promise<never> {
  try {
    await emit(value, { format: opts.format });
  } catch {
    // stdout is gone too; the tool still ran, so keep the error below
  } finally {
    reportCredit(creditCost);
  }
  throw new HgiError('local_state_error', `The tool ran, but ${cause.message.replace(/^Could not/, 'hgi could not')}`, {
    hint: 'The tool already ran and was billed; its result was printed to stdout. Do NOT re-run it. Check the budget with `hgi budget status`.',
    details: { kind: 'budget_write_failed', tool_ran: true },
    cause,
  });
}

async function runInvoke(verb: Verb, toolName: string, opts: InvokeOptions, cmd: Command): Promise<void> {
  const batchSize = preflightBatchFlags(opts);
  const input = await readInput(opts.input);
  preflightOutput({ format: opts.format, select: opts.select, out: opts.out, force: opts.force, allowForce: verb === 'run' });
  const timeoutMs = parseTimeoutMs(opts.timeout);
  const label = parseLabel(opts.label);
  const ledger = ledgerPath();
  const ids = opts.ids === undefined ? undefined : await readIds({ ...opts, ids: opts.ids }, input);
  // The run cap applies to `hgi call` only. It is checked before credentials are read or anything is sent.
  const maxCredits = verb === 'call' ? resolveMaxCredits(opts.maxCredits) : null;
  const budgetId = maxCredits === null ? null : resolveBudgetId();
  if (budgetId !== null && maxCredits !== null) await checkBudget(budgetId, maxCredits);
  const ctx = buildContext(cmd);
  const creds = ctx.tokens.loadCredentials();
  const session = await openSession(ctx, { timeoutMs });
  // Recorded before interpreting (which throws on isError) and before any output, so an isError
  // result, a failed --out or a broken stdout still leaves the row. Never fails the call.
  const recordUsage = (result: CallToolResult): Promise<void> =>
    recordCall(ledger, {
      v: 1,
      ts: new Date().toISOString(),
      host: new URL(ctx.base).host,
      verb,
      tool: toolName,
      label,
      credit_cost: creditCostOf(result),
      budget_id: ledgerBudgetId(),
      mcp_version: session.state.mcpVersion,
      status: result.isError ? 'tool_error' : 'ok',
    });
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
    if (ids) {
      await runBatch(session, tool, input, ids, {
        batchSize,
        format: opts.format,
        select: opts.select,
        out: opts.out,
        meta: opts.meta,
        validate: opts.validate,
        budget: budgetId !== null && maxCredits !== null ? { id: budgetId, max: maxCredits } : undefined,
        onResult: recordUsage,
      });
      return;
    }
    if (opts.validate) assertValidInput(tool, input);

    const result = await session.callTool(toolName, input);
    await recordUsage(result);
    let budgetFailure: HgiError | null = null;
    if (budgetId !== null && maxCredits !== null) {
      try {
        await recordSpend(budgetId, maxCredits, creditCostOf(result));
      } catch (err) {
        budgetFailure = toHgiError(err);
      }
    }
    let outcome: ReturnType<typeof interpretResult>;
    try {
      outcome = interpretResult(result, toolName);
    } catch (err) {
      // A server refusal stays the error the caller acts on; a failed budget write is only flagged on it.
      if (budgetFailure && err instanceof HgiError) {
        throw new HgiError(err.code, err.message, { hint: err.hint, details: { ...err.details, budget_write_failed: true }, cause: err });
      }
      throw err;
    }
    const selected = applySelect(outcome.value, opts.select);
    const value = opts.meta
      ? { result: selected, credit_cost: outcome.creditCost, mcp_version: session.state.mcpVersion }
      : selected;
    if (budgetFailure) await failAfterBudgetWrite(budgetFailure, value, opts, outcome.creditCost);
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
    const cmd = program
      .command(`${verb} <tool>`)
      .description(describeVerb[verb])
      .option('--input <json>', 'tool arguments as a JSON object; @file or - reads a file or stdin')
      .option('-f, --format <format>', 'json|jsonl|csv|yaml|table')
      .option('--select <fields>', 'keep only these comma-separated fields (dotted paths allowed)')
      .option('--out <file>', 'write the result to a new file instead of stdout')
      .option('--force', verb === 'run' ? 'overwrite an existing --out file' : 'not available on call')
      .option('--meta', 'print {result, credit_cost, mcp_version} instead of the bare result')
      .option('--label <label>', 'tag this call in the local credit ledger (see `hgi usage --by label`)')
      .option('--timeout <seconds>', 'per-request timeout', '120')
      .addOption(new Option('--no-validate', 'skip client-side schema validation (let the server judge the input)').hideHelp());
    if (verb === 'call') {
      cmd
        .option('--ids <source>', 'batch over HG ids or domains, one per line: @file or - (stdin); prints one row per line')
        .option('--ids-column <name>', 'with --ids, read the file as CSV with a header row and take ids from this column')
        .option('--batch-size <n>', "with --ids, send fewer ids per call than the tool's limit")
        .option('--max-credits <n>', 'stop this run once it has spent n credits (also $HGI_MAX_CREDITS; the flag wins)')
        .addHelpText(
          'after',
          [
            '',
            'Run cap (client-side, on top of the server limits):',
            '  --max-credits <n> / HGI_MAX_CREDITS  refuse the call, sending nothing (exit 13), once this run has spent n credits',
            '  HGI_BUDGET_ID                        the run to count against (default: the parent process id, so one shell or script)',
            '  `hgi budget status` shows the spend; `hgi budget reset` starts it over.',
            '  With --ids, every batch call is checked and counted.',
          ].join('\n'),
        );
    }
    cmd.action((tool: string, opts: InvokeOptions, c: Command) => runInvoke(verb, tool, opts, c));
  }
}

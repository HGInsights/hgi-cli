import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { protectedDirs } from '../config.js';
import { checkBudget, recordSpend } from '../budget.js';
import { HgiError, toHgiError } from '../errors.js';
import { parseCsvColumn, parseIdLines, type IdLine } from '../batch/ids.js';
import { batchFields, buildBatches, entriesKey, matchEntries, type Batch, type BatchPlan, type UniqueInput } from '../batch/plan.js';
import { creditCostOf, interpretResult } from '../mcp/result.js';
import type { McpSession } from '../mcp/session.js';
import type { McpTool } from '../mcp/tools.js';
import { assertValidInput } from '../mcp/validate.js';
import { formatValue, parseFormat, type Format } from '../output/format.js';
import { readInputFile } from '../output/out-file.js';
import { escapeJsonForTerminal, sanitizeForTerminal } from '../output/sanitize.js';
import { applySelect } from '../output/select.js';
import { writeStream } from '../output/stdout.js';
import { redact } from '../redact.js';
import { emitText } from './emit.js';
import { readStdin, reportCredit } from './io.js';

export interface BatchFlags {
  input?: string;
  ids?: string;
  idsColumn?: string;
  batchSize?: string;
}

export interface BatchOptions {
  batchSize?: number;
  format?: string;
  select?: string;
  out?: string;
  meta?: boolean;
  validate: boolean;
  /** The run cap (`--max-credits`): checked before every batch call, and each call's cost recorded after it. */
  budget?: { id: string; max: number };
}

interface RowError {
  code: string;
  message: string;
}

type Outcome = { result: unknown } | { error: RowError };
type Row = { input: string } & Outcome;

function usage(message: string, reason: string, hint?: string, extra: Record<string, unknown> = {}): HgiError {
  return new HgiError('invalid_input', message, { hint, details: { reason, ...extra } });
}

/** Flag checks that need no I/O. Returns the parsed --batch-size. */
export function preflightBatchFlags(flags: BatchFlags): number | undefined {
  if (flags.ids === undefined) {
    if (flags.idsColumn !== undefined) throw usage('--ids-column needs --ids.', 'ids_column_without_ids');
    if (flags.batchSize !== undefined) throw usage('--batch-size needs --ids.', 'batch_size_without_ids');
    return undefined;
  }
  if (flags.ids !== '-' && !flags.ids.startsWith('@')) {
    throw usage('--ids takes @file or - (stdin).', 'bad_ids_source', `Did you mean --ids @${flags.ids}?`);
  }
  if (flags.ids === '-' && flags.input === '-') {
    throw usage('--ids - and --input - cannot both read stdin.', 'stdin_conflict', 'Pass one of them as @file.');
  }
  if (flags.batchSize === undefined) return undefined;
  const raw = flags.batchSize.trim();
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) {
    throw usage(`--batch-size must be a whole number of at least 1, not "${flags.batchSize}".`, 'bad_batch_size');
  }
  return n;
}

/** Reads and parses the --ids source. Runs before any network traffic. */
export async function readIds(flags: BatchFlags & { ids: string }, input: Record<string, unknown>): Promise<IdLine[]> {
  for (const field of ['hg_ids', 'domains']) {
    if (field in input) {
      throw usage(`--ids builds "${field}" itself; remove it from --input.`, 'ids_conflict', undefined, { field });
    }
  }
  const text = flags.ids === '-' ? await readStdin() : readInputFile(flags.ids.slice(1), protectedDirs(), {}, '--ids @file');
  const lines = flags.idsColumn !== undefined ? parseCsvColumn(text, flags.idsColumn) : parseIdLines(text);
  if (lines.length === 0) {
    throw usage('--ids holds no HG ids or domains (only blank lines or # comments).', 'no_ids');
  }
  return lines;
}

function argsFor(input: Record<string, unknown>, batch: Batch): Record<string, unknown> {
  return { ...input, [batch.field]: batch.items.map((u) => u.text) };
}

function stdoutIsTty(): boolean {
  return Boolean(process.stdout.isTTY);
}

function render(rows: Row[], format: Format): string {
  if (format === 'jsonl') return rows.map((r) => `${JSON.stringify(r)}\n`).join('');
  return formatValue(rows, format, { pretty: stdoutIsTty() });
}

class Run {
  readonly outcomes = new Map<UniqueInput, Outcome>();
  readonly rows: Row[] = [];
  rowErrors = 0;
  cursor = 0;
  callsMade = 0;
  callsWithoutCost = 0;
  creditSum = 0;
  failedBatches = 0;

  constructor(
    readonly plan: BatchPlan,
    readonly format: Format,
    readonly streaming: boolean,
  ) {}

  /** Emits every row, in input order, whose batch has returned. */
  async flush(select: string | undefined): Promise<void> {
    while (this.cursor < this.plan.lines.length) {
      const line = this.plan.lines[this.cursor] as BatchPlan['lines'][number];
      const outcome = this.outcomes.get(line.unique);
      if (!outcome) return;
      const row: Row = 'result' in outcome ? { input: line.text, result: applySelect(outcome.result, select) } : { input: line.text, error: outcome.error };
      if ('error' in row) this.rowErrors += 1;
      this.rows.push(row);
      this.cursor += 1;
      if (this.streaming) {
        const text = `${JSON.stringify(row)}\n`;
        await writeStream(process.stdout, stdoutIsTty() ? escapeJsonForTerminal(text) : text);
      }
    }
  }

  addCost(result: CallToolResult | undefined): void {
    const cost = result ? creditCostOf(result) : null;
    if (cost === null) this.callsWithoutCost += 1;
    else this.creditSum += cost;
  }

  creditCost(): number | null {
    return this.callsMade > this.callsWithoutCost ? this.creditSum : null;
  }

  failBatch(batch: Batch, error: RowError): void {
    this.failedBatches += 1;
    for (const u of batch.items) this.outcomes.set(u, { error });
  }
}

function rowError(code: string, message: string): RowError {
  return { code, message: redact(message) };
}

/**
 * Sends one batch. Returns the error from recording its spend under a run cap, if that failed: the caller
 * prints this batch's rows first, then stops the run with it.
 */
async function callBatch(
  run: Run,
  session: McpSession,
  tool: McpTool,
  input: Record<string, unknown>,
  batch: Batch,
  key: string,
  budget: BatchOptions['budget'],
): Promise<HgiError | null> {
  run.callsMade += 1;
  let result: CallToolResult | undefined;
  let budgetFailure: HgiError | null = null;
  try {
    result = await session.callTool(tool.name, argsFor(input, batch));
    run.addCost(result);
    if (budget) {
      try {
        await recordSpend(budget.id, budget.max, creditCostOf(result));
      } catch (err) {
        budgetFailure = toHgiError(err);
      }
    }
    const outcome = interpretResult(result, tool.name);
    const index = matchEntries(batch.kind, outcome.value, key);
    if (!index) {
      run.failBatch(batch, rowError('unexpected_response', `The response has no "${key}" array to match inputs against.`));
      return budgetFailure;
    }
    for (const u of batch.items) {
      const entry = index.get(u.norm);
      run.outcomes.set(u, entry ? { result: entry } : { error: rowError('not_found', `No ${u.kind === 'id' ? 'company for this HG id' : 'company for this domain'} in the response.`) });
    }
  } catch (raw) {
    if (!result) run.addCost(undefined);
    const err = toHgiError(raw);
    if (err.code !== 'tool_error' || err.details?.outcome_unknown === true) {
      // A server refusal stays the error the caller acts on; a failed budget write is only flagged on it.
      if (budgetFailure) throw new HgiError(err.code, err.message, { hint: err.hint, details: { ...err.details, budget_write_failed: true }, cause: err });
      throw err;
    }
    run.failBatch(batch, rowError(err.code, err.message));
  }
  return budgetFailure;
}

/** Before every batch after the first (the first is checked before anything is sent): refuses once the run cap is spent. */
async function checkBatchBudget(budget: NonNullable<BatchOptions['budget']>, run: Run): Promise<void> {
  try {
    await checkBudget(budget.id, budget.max);
  } catch (raw) {
    const err = toHgiError(raw);
    if (err.code !== 'budget_exceeded') throw err;
    throw new HgiError(err.code, err.message, {
      hint: `${run.callsMade} batch call(s) already ran and their rows were printed; nothing more was sent. Keep those rows, raise --max-credits or run \`hgi budget reset\`, then resume from the rest.`,
      details: err.details,
      cause: err,
    });
  }
}

function printMeta(run: Run): void {
  process.stderr.write(
    `${JSON.stringify({
      calls: run.callsMade,
      rows: run.rows.length,
      row_errors: run.rowErrors,
      credit_cost: run.creditCost(),
      calls_without_cost: run.callsWithoutCost,
    })}\n`,
  );
}

/** Writes buffered rows. Returns false when --out could not be written and the rows went to stdout instead. */
async function writeBuffered(run: Run, opts: BatchOptions): Promise<{ outError?: HgiError }> {
  if (run.streaming) return {};
  const text = render(run.rows, run.format);
  if (!opts.out) {
    await emitText(text, run.format);
    return {};
  }
  try {
    await emitText(text, run.format, { out: opts.out });
    return {};
  } catch (err) {
    const outError = toHgiError(err);
    const note = `hgi: could not write ${opts.out} (${String(outError.details?.reason ?? outError.code)}); the rows were printed to stdout instead.`;
    process.stderr.write(`${sanitizeForTerminal(redact(note))}\n`);
    try {
      await emitText(text, run.format);
    } catch {
      // stdout is gone too; the error below still says what happened
    }
    return { outError };
  }
}

function withProgress(details: Record<string, unknown> | undefined, run: Run, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...details, rows_emitted: run.rows.length, calls_made: run.callsMade, ...extra };
}

export async function runBatch(session: McpSession, tool: McpTool, input: Record<string, unknown>, lines: IdLine[], opts: BatchOptions): Promise<void> {
  const plan = buildBatches(lines, batchFields(tool), opts.batchSize);
  if (opts.validate) {
    plan.batches.forEach((batch, i) => {
      try {
        assertValidInput(tool, argsFor(input, batch));
      } catch (err) {
        const e = toHgiError(err);
        throw new HgiError(e.code, `Batch ${i + 1} of ${plan.batches.length}: ${e.message}`, {
          hint: `${e.hint ?? ''} Nothing was sent.`.trim(),
          details: { ...e.details, batch: i + 1 },
        });
      }
    });
  }
  const format = opts.format ? parseFormat(opts.format) : 'jsonl';
  const run = new Run(plan, format, format === 'jsonl' && !opts.out);
  const key = entriesKey(tool);

  try {
    for (const [i, batch] of plan.batches.entries()) {
      if (opts.budget && i > 0) await checkBatchBudget(opts.budget, run);
      if (process.stderr.isTTY) process.stderr.write(`hgi: batch ${i + 1}/${plan.batches.length}\n`);
      const budgetFailure = await callBatch(run, session, tool, input, batch, key, opts.budget);
      await run.flush(opts.select);
      if (budgetFailure) {
        throw new HgiError('local_state_error', `The batch call ran, but ${budgetFailure.message.replace(/^Could not/, 'hgi could not')}`, {
          hint: 'Every call so far already ran and was billed, and its rows were printed. Do NOT re-run them. Check the budget with `hgi budget status`.',
          details: { kind: 'budget_write_failed', tool_ran: true },
          cause: budgetFailure,
        });
      }
    }
  } catch (raw) {
    const err = toHgiError(raw);
    let outFailed = false;
    try {
      outFailed = (await writeBuffered(run, opts)).outError !== undefined;
    } catch {
      // stdout is gone; report the original error
    }
    reportCredit(run.creditCost());
    if (opts.meta) printMeta(run);
    throw new HgiError(err.code, err.message, {
      hint: err.hint,
      details: withProgress(err.details, run, outFailed ? { out_write_failed: true } : {}),
      cause: err,
    });
  }

  let outError: HgiError | undefined;
  try {
    ({ outError } = await writeBuffered(run, opts));
  } finally {
    reportCredit(run.creditCost());
    if (opts.meta) printMeta(run);
  }
  if (outError) {
    throw new HgiError('local_state_error', `The batch ran, but its rows could not be written to ${opts.out}: ${outError.message}`, {
      hint: 'Every call already ran and was billed; the rows were printed to stdout instead. Do NOT re-run it.',
      details: { kind: 'write_failed', reason: outError.details?.reason ?? outError.code, tool_ran: true, ...withProgress(undefined, run) },
      cause: outError,
    });
  }
  if (run.failedBatches > 0) {
    throw new HgiError('tool_error', `${run.failedBatches} of ${plan.batches.length} batch calls failed; their rows carry the error.`, {
      hint: 'Every other row was printed. Re-run only the inputs whose rows have an error.',
      details: withProgress({ failed_batches: run.failedBatches }, run),
    });
  }
}

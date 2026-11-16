import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { protectedDirs } from '../config.js';
import { checkBudget, recordSpend } from '../budget.js';
import { HgiError, toHgiError } from '../errors.js';
import { parseCsvColumn, parseIdLines, type IdLine } from '../batch/ids.js';
import { batchFields, buildBatches, entriesKey, matchEntries, type Batch, type BatchPlan, type UniqueInput } from '../batch/plan.js';
import { creditCostOf, interpretResult } from '../mcp/result.js';
import type { PagingSpec } from '../mcp/paging.js';
import { isRecord } from '../mcp/schema-shape.js';
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
import { readStdin, reportCredit, reportRetry } from './io.js';
import { companyPager, type CompanyPager } from './paging.js';
import { sendWithRetry } from './retry.js';

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
  /** Called with every result that came back (the credit ledger). Never throws. */
  onResult?: (result: CallToolResult) => Promise<void>;
  /** `governance_unavailable` re-sends per batch call (0: none) and their wait budget. */
  governance?: { retries: number; budgetMs: number };
  /** `--all-pages`: page every company of each batch on its own (see docs/output-formats.md). */
  paging?: { spec: PagingSpec; maxPages: number };
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
  /** `tools/call` re-sends across all batch calls (transport retries and governance re-sends). */
  retries = 0;
  callsWithoutCost = 0;
  creditSum = 0;
  failedBatches = 0;
  /** `--all-pages`: companies whose paging a tool error ended early. */
  pagingFailures = 0;
  /** `--all-pages`: rows whose result is marked truncated. */
  truncatedRows = 0;

  constructor(
    readonly plan: BatchPlan,
    readonly format: Format,
    readonly streaming: boolean,
    readonly paging = false,
  ) {}

  /** Emits every row, in input order, whose batch has returned. */
  async flush(select: string | undefined): Promise<void> {
    while (this.cursor < this.plan.lines.length) {
      const line = this.plan.lines[this.cursor] as BatchPlan['lines'][number];
      const outcome = this.outcomes.get(line.unique);
      if (!outcome) return;
      const row: Row = 'result' in outcome ? { input: line.text, result: applySelect(outcome.result, select) } : { input: line.text, error: outcome.error };
      if ('error' in row) this.rowErrors += 1;
      else if ('result' in outcome && isRecord(outcome.result) && outcome.result.truncated === true) this.truncatedRows += 1;
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

/** A failure that becomes a row error (or a truncated row) while the run goes on. Anything else stops the run. */
function isRowFailure(err: HgiError): boolean {
  return err.code === 'tool_error' && err.details?.outcome_unknown !== true && err.details?.budget_write_failed !== true;
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
  opts: Pick<BatchOptions, 'budget' | 'onResult' | 'governance'>,
): Promise<HgiError | null> {
  const { budget } = opts;
  run.callsMade += 1;
  let result: CallToolResult | undefined;
  let budgetFailure: HgiError | null = null;
  const sendsBefore = session.state.toolsCallSends;
  const governanceRetries = opts.governance?.retries ?? 0;
  let attempts = 1;
  try {
    ({ result, budgetFailure, attempts } = await sendWithRetry(session, tool.name, argsFor(input, batch), {
      retries: governanceRetries,
      budgetMs: opts.governance?.budgetMs ?? 0,
      // Every attempt that came back: one ledger row, and its spend under a run cap.
      record: async (r) => {
        await opts.onResult?.(r);
        if (!budget) return null;
        try {
          await recordSpend(budget.id, budget.max, creditCostOf(r));
          return null;
        } catch (err) {
          return toHgiError(err);
        }
      },
      beforeResend: budget ? () => checkBatchBudget(budget, run) : undefined,
      report: reportRetry,
    }));
    // Refused attempts are not billed: the batch call's cost is its last result's.
    run.addCost(result);
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
    if (!isRowFailure(err)) {
      // A server refusal stays the error the caller acts on; a failed budget write is only flagged on it.
      const retried = governanceRetries > 0 && err.code === 'governance_unavailable';
      if (budgetFailure || retried) {
        const extra = { ...(budgetFailure ? { budget_write_failed: true } : {}), ...(retried ? { attempts } : {}) };
        throw new HgiError(err.code, err.message, { hint: err.hint, details: { ...err.details, ...extra }, cause: err });
      }
      throw err;
    }
    run.failBatch(batch, rowError(err.code, err.message));
  } finally {
    run.retries += Math.max(0, session.state.toolsCallSends - sendsBefore - 1);
  }
  return budgetFailure;
}

/** Before every batch after the first (the first is checked before anything is sent): refuses once the run cap is spent. */
async function checkBatchBudget(budget: NonNullable<BatchOptions['budget']>, run: Run): Promise<void> {
  try {
    await checkBudget(budget.id, budget.max);
  } catch (raw) {
    throw capReached(toHgiError(raw), run);
  }
}

/** The run cap stopped the run: says the rows so far were printed. Any other error is returned as it is. */
function capReached(err: HgiError, run: Run): HgiError {
  if (err.code !== 'budget_exceeded') return err;
  const calls = run.paging ? 'call(s)' : 'batch call(s)';
  return new HgiError(err.code, err.message, {
    hint: `${run.callsMade} ${calls} already ran and their rows were printed; nothing more was sent. Keep those rows, raise --max-credits or run \`hgi budget reset\`, then resume from the rest.`,
    details: err.details,
    cause: err,
  });
}

/** A call ran but its spend could not be recorded under the run cap: exit 12 `budget_write_failed`, `tool_ran`. */
function budgetWriteFailed(budgetFailure: HgiError, what: string): HgiError {
  return new HgiError('local_state_error', `The ${what} ran, but ${budgetFailure.message.replace(/^Could not/, 'hgi could not')}`, {
    hint: 'Every call so far already ran and was billed, and its rows were printed. Do NOT re-run them. Check the budget with `hgi budget status`.',
    details: { kind: 'budget_write_failed', tool_ran: true },
    cause: budgetFailure,
  });
}

function printMeta(run: Run): void {
  process.stderr.write(
    `${JSON.stringify({
      calls: run.callsMade,
      retries: run.retries,
      rows: run.rows.length,
      row_errors: run.rowErrors,
      ...(run.paging ? { truncated_rows: run.truncatedRows } : {}),
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

interface Driver {
  run: Run;
  session: McpSession;
  tool: McpTool;
  input: Record<string, unknown>;
  key: string;
  opts: BatchOptions;
}

/** Sends batch `i` as `--ids` sends it: the run cap checked first (except on the first call), then the call. */
async function sendBatch(d: Driver, i: number): Promise<HgiError | null> {
  const { run, opts } = d;
  const batch = run.plan.batches[i] as Batch;
  if (opts.budget && i > 0) await checkBatchBudget(opts.budget, run);
  if (process.stderr.isTTY) process.stderr.write(`hgi: batch ${i + 1}/${run.plan.batches.length}\n`);
  return callBatch(run, d.session, d.tool, d.input, batch, d.key, opts);
}

/** `--ids` alone: batches in order, each batch's rows printed as it returns. */
async function runBatches(d: Driver): Promise<void> {
  for (const i of d.run.plan.batches.keys()) {
    const budgetFailure = await sendBatch(d, i);
    await d.run.flush(d.opts.select);
    if (budgetFailure) throw budgetWriteFailed(budgetFailure, 'batch call');
  }
}

/**
 * `--ids` with `--all-pages`, driven by input order: each company's batch is sent (whole, as `--ids` sends it) when
 * its first company is reached, then that company is paged on its own. So the company being paged is always the
 * next row due, and its row is printed even when a failure stops the run.
 */
async function runPagedBatches(d: Driver, pager: CompanyPager): Promise<void> {
  const { run, opts } = d;
  const batchOf = new Map<UniqueInput, number>();
  run.plan.batches.forEach((b, i) => b.items.forEach((u) => batchOf.set(u, i)));
  const sent = new Set<number>();
  // Every page-1 outcome, errors included, waits here until its company is reached, so a stop never prints a
  // row for a company the run did not reach.
  const pending = new Map<UniqueInput, Outcome>();
  const reached = new Set<UniqueInput>();
  for (const { unique: u } of run.plan.lines) {
    if (reached.has(u)) continue;
    reached.add(u);
    const i = batchOf.get(u) as number;
    const batch = run.plan.batches[i] as Batch;
    if (!sent.has(i)) {
      sent.add(i);
      const budgetFailure = await sendBatch(d, i);
      for (const item of batch.items) {
        const outcome = run.outcomes.get(item);
        if (!outcome) continue;
        run.outcomes.delete(item);
        pending.set(item, outcome);
      }
      if (budgetFailure) {
        // No follow-up once spend can't be recorded: every company not yet paged keeps page 1, as `--ids` prints it.
        for (const [item, outcome] of pending) {
          run.outcomes.set(item, 'result' in outcome && isRecord(outcome.result) ? { result: pager.settle(outcome.result, 'local_state_error') } : outcome);
        }
        await run.flush(opts.select);
        throw budgetWriteFailed(budgetFailure, 'batch call');
      }
    }
    const outcome = pending.get(u);
    if (!outcome) continue;
    pending.delete(u);
    if (!('result' in outcome) || !isRecord(outcome.result)) {
      // A row error from page 1 (not_found, a failed batch): nothing to page.
      run.outcomes.set(u, outcome);
      await run.flush(opts.select);
      continue;
    }
    const { merged, failure } = await pager.page(outcome.result, { field: batch.field, text: u.text, kind: u.kind, norm: u.norm });
    run.outcomes.set(u, { result: merged });
    await run.flush(opts.select);
    if (!failure) continue;
    if (isRowFailure(failure)) {
      run.pagingFailures += 1;
      continue;
    }
    if (failure.code === 'local_state_error' && failure.details?.kind === 'budget_write_failed') throw budgetWriteFailed(failure, 'follow-up page');
    throw capReached(failure, run);
  }
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
  const run = new Run(plan, format, format === 'jsonl' && !opts.out, opts.paging !== undefined);
  const driver: Driver = { run, session, tool, input, key: entriesKey(tool), opts };

  try {
    if (opts.paging) {
      const { spec, maxPages } = opts.paging;
      const pagingCtx = {
        session,
        tool,
        input,
        spec,
        maxPages,
        validate: opts.validate,
        budget: opts.budget,
        onResult: opts.onResult,
        governance: opts.governance,
      };
      await runPagedBatches(driver, companyPager(pagingCtx, run));
    } else {
      await runBatches(driver);
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
      details: withProgress(err.details, run, { ...(run.paging ? { partial_result: true } : {}), ...(outFailed ? { out_write_failed: true } : {}) }),
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
  if (run.pagingFailures > 0) {
    const batches = run.failedBatches > 0 ? `${run.failedBatches} of ${plan.batches.length} batch calls failed, and ` : '';
    const companies = `${run.pagingFailures} ${run.pagingFailures === 1 ? 'company' : 'companies'}`;
    throw new HgiError('tool_error', `${batches}paging stopped early on a tool error for ${companies}.`, {
      hint: 'Every row was printed. Rows with truncated_reason "tool_error" hold the pages fetched before the error; rows with an error hold none. Re-run only those inputs.',
      details: withProgress({ failed_batches: run.failedBatches, paging_failures: run.pagingFailures }, run),
    });
  }
  if (run.failedBatches > 0) {
    throw new HgiError('tool_error', `${run.failedBatches} of ${plan.batches.length} batch calls failed; their rows carry the error.`, {
      hint: 'Every other row was printed. Re-run only the inputs whose rows have an error.',
      details: withProgress({ failed_batches: run.failedBatches, ...(run.paging ? { paging_failures: 0 } : {}) }, run),
    });
  }
}

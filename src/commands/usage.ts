import type { Command } from 'commander';
import { resolveBaseUrl } from '../config.js';
import { setDebug } from '../debug.js';
import { filterRows, ledgerPath, parseBy, parseSince, readLedger, summarize, type LedgerRecord } from '../ledger.js';
import { defaultFormat, parseFormat } from '../output/format.js';
import { emit, preflightOutput } from './emit.js';

export const LOCAL_ONLY_NOTICE = "Local to this machine: calls made by hgi here, not your organization's bill.";
export const ZERO_COST_CELL = '0 (server cache or free tool)';
const TABLE_FOOTNOTE = [
  'zero_cost_calls: calls the server reported as costing 0 credits (a server-side cache hit or a free tool).',
  'unknown_cost_calls: calls whose cost the server did not report; they are not counted in credits.',
].join('\n');

interface UsageOptions {
  since?: string;
  by: string;
  format?: string;
  select?: string;
  out?: string;
}

/** Table cells only: machine formats keep numbers and null. */
function forTable(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const key of ['credits', 'credit_cost']) {
      if (out[key] === 0) out[key] = ZERO_COST_CELL;
    }
    if ('label' in out && out.label === null) out.label = '(none)';
    return out;
  });
}

function note(text: string): void {
  process.stderr.write(`${text}\n`);
}

export function registerUsageCommands(program: Command): void {
  program
    .command('usage')
    .description("Summarize the credits hgi spent on this machine (local ledger; not your organization's bill)")
    .option('--since <when>', 'only calls since a date, datetime, "today", or a duration such as 24h or 7d')
    .option('--by <key>', 'tool|label|day|call (call lists the ledger rows themselves)', 'tool')
    .option('-f, --format <format>', 'json|jsonl|csv|yaml|table')
    .option('--select <fields>', 'keep only these comma-separated fields')
    .option('--out <file>', 'write to a new file instead of stdout')
    .action(async (opts: UsageOptions, cmd: Command) => {
      const by = parseBy(opts.by);
      const since = opts.since === undefined ? null : parseSince(opts.since);
      preflightOutput({ format: opts.format, select: opts.select, out: opts.out });
      const globals = cmd.optsWithGlobals<{ baseUrl?: string; debug?: boolean }>();
      setDebug(Boolean(globals.debug) || process.env.HGI_DEBUG === '1');
      const host = new URL(resolveBaseUrl(globals.baseUrl ?? process.env.HGI_BASE_URL)).host;
      const file = ledgerPath();
      const format = opts.format ? parseFormat(opts.format) : defaultFormat(Boolean(process.stdout.isTTY));

      note(LOCAL_ONLY_NOTICE);
      let rows: LedgerRecord[] = [];
      if (file === null) {
        note('hgi: the credit ledger is disabled (HGI_LEDGER=off); nothing is recorded on this machine.');
      } else {
        const read = readLedger(file);
        if (read.status === 'missing') {
          note('hgi: nothing has been recorded on this machine yet.');
        } else {
          if (read.malformed > 0) {
            note(`hgi: warning: skipped ${read.malformed} malformed ledger line${read.malformed === 1 ? '' : 's'}.`);
          }
          if (read.rows.length === 0 && read.malformed === 0) note('hgi: nothing has been recorded on this machine yet.');
          rows = filterRows(read.rows, host, since);
        }
      }

      const value: Array<Record<string, unknown>> =
        by === 'call' ? rows.map((r) => ({ ...r })) : summarize(rows, by);
      await emit(format === 'table' ? forTable(value) : value, { format, select: opts.select, out: opts.out });
      if (format === 'table') note(TABLE_FOOTNOTE);
    });
}

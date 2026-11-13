import type { Command } from 'commander';
import { readBudget, resetBudget, resolveBudgetId, resolveMaxCredits, type BudgetState } from '../budget.js';
import { emit, preflightOutput } from './emit.js';

interface StatusOptions {
  maxCredits?: string;
  format?: string;
  select?: string;
  out?: string;
}

interface BudgetStatus {
  budget_id: string;
  spent: number;
  max: number | null;
  remaining: number | null;
  calls: number;
  unknown_cost_calls: number;
}

/** `max` comes from the flag, else HGI_MAX_CREDITS, else the cap stored by the last capped call. */
function budgetStatus(state: BudgetState, activeMax: number | null): BudgetStatus {
  const max = activeMax ?? state.max;
  return {
    budget_id: state.budget_id,
    spent: state.spent,
    max,
    remaining: max === null ? null : Math.max(0, max - state.spent),
    calls: state.calls,
    unknown_cost_calls: state.unknown_cost_calls,
  };
}

export function registerBudgetCommands(program: Command): void {
  const budget = program
    .command('budget')
    .description('See or reset what this run has spent against --max-credits (local only; sends nothing)');

  budget
    .command('status')
    .description('Print the current budget: {budget_id, spent, max, remaining, calls, unknown_cost_calls}')
    .option('--max-credits <n>', 'report against this cap (default: $HGI_MAX_CREDITS, else the last cap used)')
    .option('-f, --format <format>', 'json|jsonl|csv|yaml|table')
    .option('--select <fields>', 'keep only these comma-separated fields')
    .option('--out <file>', 'write to a new file instead of stdout')
    .action(async (opts: StatusOptions) => {
      preflightOutput({ format: opts.format, select: opts.select, out: opts.out });
      const max = resolveMaxCredits(opts.maxCredits);
      const state = readBudget(resolveBudgetId());
      await emit(budgetStatus(state, max), { format: opts.format, select: opts.select, out: opts.out });
    });

  budget
    .command('reset')
    .description('Set this budget\'s spent, calls and unknown_cost_calls to 0, then print its status')
    .option('-f, --format <format>', 'json|jsonl|csv|yaml|table')
    .action(async (opts: { format?: string }) => {
      preflightOutput({ format: opts.format });
      const max = resolveMaxCredits(undefined);
      const state = await resetBudget(resolveBudgetId());
      await emit(budgetStatus(state, max), { format: opts.format });
    });
}

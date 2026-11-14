import { HgiError } from '../errors.js';

type Env = NodeJS.ProcessEnv;

export const MAX_RETRIES = 20;
export const MAX_RETRY_BUDGET_SECONDS = 3600;
/** The per-request retry budget when `--retries` is set and `--retry-budget` is not. */
export const RETRIES_DEFAULT_BUDGET_MS = 600_000;

/**
 * What `--retries` / `--retry-budget` (or their env vars) resolved to. `null` means "not given": without either,
 * the transport keeps today's built-in limits and 60 s budget exactly.
 */
export interface RetryOptions {
  retries: number | null;
  retryBudgetMs: number | null;
}

export function parseRetries(raw: string, source: string): number {
  const trimmed = raw.trim();
  const value = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isSafeInteger(value) || value > MAX_RETRIES) {
    // The value is never echoed: a token pasted into the wrong place must not reach the terminal or a log.
    throw new HgiError('invalid_input', `${source} must be a whole number from 0 to ${MAX_RETRIES}.`, {
      hint: 'For example --retries 6. 0 turns every retry off.',
      details: { reason: 'bad_retries' },
    });
  }
  return value;
}

export function parseRetryBudget(raw: string, source: string): number {
  const trimmed = raw.trim();
  const seconds = trimmed === '' ? Number.NaN : Number(trimmed);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_RETRY_BUDGET_SECONDS) {
    throw new HgiError('invalid_input', `${source} must be a positive number of seconds, at most ${MAX_RETRY_BUDGET_SECONDS}.`, {
      hint: 'For example --retry-budget 600.',
      details: { reason: 'bad_retry_budget' },
    });
  }
  return seconds * 1000;
}

/** The flag wins over the env var; an empty variable counts as unset (like `--max-credits` / `HGI_MAX_CREDITS`). */
export function resolveRetryOptions(flags: { retries?: string; retryBudget?: string }, env: Env = process.env): RetryOptions {
  let retries: number | null = null;
  if (flags.retries !== undefined) retries = parseRetries(flags.retries, '--retries');
  else if (env.HGI_RETRIES) retries = parseRetries(env.HGI_RETRIES, 'HGI_RETRIES');
  let retryBudgetMs: number | null = null;
  if (flags.retryBudget !== undefined) retryBudgetMs = parseRetryBudget(flags.retryBudget, '--retry-budget');
  else if (env.HGI_RETRY_BUDGET) retryBudgetMs = parseRetryBudget(env.HGI_RETRY_BUDGET, 'HGI_RETRY_BUDGET');
  return { retries, retryBudgetMs };
}

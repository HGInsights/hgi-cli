import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { HgiError } from '../errors.js';
import { sleep as defaultSleep } from '../http.js';
import type { McpSession } from '../mcp/session.js';
import { roundWait, type RetryEvent } from './io.js';

/** The longest single `governance_unavailable` wait, in seconds (full jitter in `[0, min(2^attempt, 30)]`). */
const GOVERNANCE_MAX_WAIT_SECONDS = 30;

export interface SendOptions {
  /**
   * How many times a `governance_unavailable` result may be re-sent. 0 sends once: `hgi run`, or `hgi call` without
   * `--retries`. The server raises this code before the tool runs, so a re-send on a read-only call is safe.
   */
  retries: number;
  /** Total wait allowed between re-sends, measured from the first send. */
  budgetMs: number;
  /** Records one attempt that came back (ledger row, run-cap spend). Returns the run-cap write failure, if any. */
  record: (result: CallToolResult) => Promise<HgiError | null>;
  /** Right before every re-send (after the wait): the run-cap check, which throws exit 13 to stop. */
  beforeResend?: () => Promise<void>;
  report: (e: RetryEvent) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export interface SendOutcome {
  /** The last result that came back; every earlier one was a `governance_unavailable` refusal. */
  result: CallToolResult;
  /** How many times the `tools/call` was sent, transport retries included. */
  attempts: number;
  /** Set when recording the last result's spend failed (exit 12 after the result is handled). */
  budgetFailure: HgiError | null;
}

function isGovernanceUnavailable(result: CallToolResult): boolean {
  return result.isError === true && (result._meta as { errorCode?: unknown } | undefined)?.errorCode === 'governance_unavailable';
}

/**
 * Sends one `tools/call` and records it; re-sends it while the server answers `governance_unavailable` and retries,
 * budget and the run cap allow. Every attempt that came back is recorded exactly as a single call is.
 */
export async function sendWithRetry(
  session: McpSession,
  name: string,
  args: Record<string, unknown>,
  opts: SendOptions,
): Promise<SendOutcome> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const sendsBefore = session.state.toolsCallSends;
  const started = now();
  for (let attempt = 1; ; attempt += 1) {
    const result = await session.callTool(name, args);
    const budgetFailure = await opts.record(result);
    const outcome = (): SendOutcome => ({ result, attempts: session.state.toolsCallSends - sendsBefore, budgetFailure });
    if (budgetFailure || attempt > opts.retries || !isGovernanceUnavailable(result)) return outcome();
    const waitMs = random() * Math.min(2 ** attempt, GOVERNANCE_MAX_WAIT_SECONDS) * 1000;
    if (waitMs > opts.budgetMs - (now() - started)) return outcome();
    opts.report({ attempt, max: opts.retries, code: 'governance_unavailable', wait_seconds: roundWait(waitMs) });
    await sleep(waitMs);
    await opts.beforeResend?.();
  }
}

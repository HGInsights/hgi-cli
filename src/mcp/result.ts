import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { HgiError, type ErrorCode } from '../errors.js';
import { redact } from '../redact.js';

export interface CallOutcome {
  value: unknown;
  creditCost: number | null;
}

const MAX_ERROR_TEXT = 2000;

function textOf(result: CallToolResult): string {
  return (result.content ?? [])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('\n');
}

export function extractValue(result: CallToolResult): unknown {
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    return result.structuredContent;
  }
  const blocks = result.content ?? [];
  const only = blocks.length === 1 ? blocks[0] : undefined;
  if (only && only.type === 'text') {
    try {
      return JSON.parse(only.text) as unknown;
    } catch {
      return { text: only.text };
    }
  }
  return { content: blocks };
}

export function creditCostOf(result: CallToolResult): number | null {
  const cost = (result._meta as { creditCost?: unknown } | undefined)?.creditCost;
  return typeof cost === 'number' && Number.isFinite(cost) ? cost : null;
}

interface Refusal {
  code: ErrorCode;
  hint: string;
  details?: Record<string, unknown>;
}

/**
 * Server refusals, keyed by `_meta.errorCode`. The mapping is decided by that field only, never by the
 * message text. Anything not listed here stays `tool_error`.
 */
const REFUSALS: Readonly<Record<string, Refusal>> = {
  credit_limit_exceeded: {
    code: 'credit_limit_exceeded',
    hint: 'Your organization has used its credit allowance. Contact your admin; retrying will not help.',
  },
  user_credit_limit_exceeded: {
    code: 'user_credit_limit_exceeded',
    hint: 'Your personal credit budget is used up. Ask an admin to raise it, or wait for the next billing period; retrying will not help.',
  },
  governance_unavailable: {
    code: 'governance_unavailable',
    hint: 'The server could not check your budget, so nothing ran. Retry shortly.',
    details: { retryable: true, outcome_unknown: false },
  },
  tool_not_enabled_for_team: {
    code: 'tool_not_enabled_for_team',
    hint: 'This tool is not enabled for your team. Ask an admin to enable it.',
  },
  phoenix_account_required: {
    code: 'phoenix_account_required',
    hint: 'This identity has no Phoenix account. Sign up for one, or sign in with `hgi auth login` as an account that has one.',
  },
};

export function serverErrorCodeOf(result: CallToolResult): string | undefined {
  const code = (result._meta as { errorCode?: unknown } | undefined)?.errorCode;
  return typeof code === 'string' ? code : undefined;
}

export function interpretResult(result: CallToolResult, toolName: string): CallOutcome {
  if (result.isError) {
    const text = redact(textOf(result)).slice(0, MAX_ERROR_TEXT) || 'The tool reported an error.';
    const serverCode = serverErrorCodeOf(result);
    const details: Record<string, unknown> = { tool: toolName };
    if (serverCode !== undefined) details.server_error_code = serverCode;
    const refusal = serverCode !== undefined && Object.hasOwn(REFUSALS, serverCode) ? REFUSALS[serverCode] : undefined;
    if (refusal) {
      throw new HgiError(refusal.code, text, { hint: refusal.hint, details: { ...details, ...refusal.details } });
    }
    throw new HgiError('tool_error', text, { details });
  }
  return { value: extractValue(result), creditCost: creditCostOf(result) };
}

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { HgiError } from '../errors.js';
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

export function interpretResult(result: CallToolResult, toolName: string): CallOutcome {
  if (result.isError) {
    const text = redact(textOf(result)).slice(0, MAX_ERROR_TEXT) || 'The tool reported an error.';
    const code = (result._meta as { errorCode?: unknown } | undefined)?.errorCode;
    if (code === 'credit_limit_exceeded') {
      throw new HgiError('credit_limit_exceeded', text, {
        hint: 'Your organization has used its credit allowance. Contact your admin; retrying will not help.',
        details: { tool: toolName },
      });
    }
    throw new HgiError('tool_error', text, { details: { tool: toolName } });
  }
  return { value: extractValue(result), creditCost: creditCostOf(result) };
}

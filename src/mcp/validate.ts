import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { debug } from '../debug.js';
import { HgiError } from '../errors.js';
import type { McpTool } from './tools.js';

const ajv = new Ajv2020.default({ strict: false, allErrors: true, allowUnionTypes: true });
(addFormats as unknown as { default: (a: unknown) => void }).default(ajv);

export interface InputIssue {
  path: string;
  message: string;
}

export function validateInput(tool: McpTool, input: unknown): InputIssue[] {
  const { $schema: _ignored, ...schema } = tool.inputSchema as Record<string, unknown>;
  void _ignored;
  let validate: ReturnType<typeof ajv.compile>;
  try {
    validate = ajv.compile(schema);
  } catch (err) {
    debug('skipping client-side validation; schema did not compile', (err as Error).message);
    return [];
  }
  if (validate(input)) return [];
  return (validate.errors ?? []).map((e) => ({
    path: e.instancePath || '/',
    message: e.message ?? 'invalid',
  }));
}

export function assertValidInput(tool: McpTool, input: unknown): void {
  const issues = validateInput(tool, input);
  if (issues.length === 0) return;
  const first = issues[0];
  throw new HgiError('invalid_input', `Input for ${tool.name} is invalid: ${first?.path} ${first?.message}.`, {
    hint: 'See `hgi tools list --json` for the tool schema.',
    details: { reason: 'schema', errors: issues.slice(0, 20) },
  });
}

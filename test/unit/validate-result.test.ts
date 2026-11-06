import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HgiError } from '../../src/errors.js';
import { clearSecrets, registerSecret } from '../../src/redact.js';
import { creditCostOf, extractValue, interpretResult } from '../../src/mcp/result.js';
import { summarize, verbFor, type McpTool } from '../../src/mcp/tools.js';
import { assertValidInput, validateInput } from '../../src/mcp/validate.js';

const tools = (JSON.parse(readFileSync(new URL('../fixtures/tools-list.json', import.meta.url), 'utf8')) as { tools: McpTool[] }).tools;
const byName = (n: string) => tools.find((t) => t.name === n) as McpTool;

describe('verbFor', () => {
  it('maps readOnlyHint true to call and everything else to run', () => {
    expect(verbFor(byName('search_companies'))).toBe('call');
    expect(verbFor(byName('phoenix_invoke_agent'))).toBe('run');
    expect(verbFor(byName('aggregated_tool'))).toBe('run');
  });
  it('summarize reports required, parameter types incl. unions, and read_only null when absent', () => {
    const s = summarize(byName('search_companies'));
    expect(s.required).toEqual(['query']);
    expect(s.parameters.find((p) => p.name === 'sort')?.type).toBe('string|object');
    expect(s.parameters.find((p) => p.name === 'limit')?.required).toBe(false);
    expect(summarize(byName('aggregated_tool')).read_only).toBeNull();
  });
});

describe('validateInput (recorded-shape fixtures)', () => {
  const search = byName('search_companies');
  it('accepts valid nested, array and union input', () => {
    expect(
      validateInput(search, {
        query: 'acme',
        limit: 10,
        industries: ['saas'],
        filters: { employees: { min: 10 }, country: 'US' },
        sort: { field: 'name', desc: true },
      }),
    ).toEqual([]);
    expect(validateInput(search, { query: 'acme', sort: 'size' })).toEqual([]);
  });
  it('reports a missing required field and wrong types with JSON-pointer paths', () => {
    expect(validateInput(search, {}).map((i) => i.message)).toContain("must have required property 'query'");
    const issues = validateInput(search, { query: 'a', limit: 'ten', filters: { employees: { min: 'x' } } });
    expect(issues.map((i) => i.path)).toEqual(expect.arrayContaining(['/limit', '/filters/employees/min']));
  });
  it('rejects values matching no union branch', () => {
    expect(validateInput(search, { query: 'a', sort: 5 }).length).toBeGreaterThan(0);
  });
  it('handles oneOf object unions and nullable arrays', () => {
    const enrich = byName('company_enrich');
    expect(validateInput(enrich, { identifier: { domain: 'a.com' }, fields: null })).toEqual([]);
    expect(validateInput(enrich, { identifier: { domain: 'a.com', name: 'x' } }).length).toBeGreaterThan(0);
  });
  it('checks formats', () => {
    expect(validateInput(byName('phoenix_invoke_agent'), { agent_id: 'not-a-uuid' }).length).toBeGreaterThan(0);
  });
  it('skips validation when the schema cannot compile instead of failing', () => {
    expect(validateInput(byName('aggregated_tool'), { anything: 1 })).toEqual([]);
  });
  it('assertValidInput throws invalid_input with details', () => {
    try {
      assertValidInput(search, {});
      throw new Error('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HgiError);
      expect((err as HgiError).code).toBe('invalid_input');
      expect((err as HgiError).details?.reason).toBe('schema');
    }
  });
});

describe('extractValue (decision 12)', () => {
  it('prefers structuredContent over the summary text', () => {
    const v = extractValue({ content: [{ type: 'text', text: 'Found 2 artifact(s).' }], structuredContent: { artifacts: [1, 2] } });
    expect(v).toEqual({ artifacts: [1, 2] });
  });
  it('parses compact and pretty JSON text blocks', () => {
    expect(extractValue({ content: [{ type: 'text', text: '{"a":1}' }] })).toEqual({ a: 1 });
    expect(extractValue({ content: [{ type: 'text', text: '{\n  "a": 1\n}' }] })).toEqual({ a: 1 });
  });
  it('wraps non-JSON text', () => {
    expect(extractValue({ content: [{ type: 'text', text: 'plain words' }] })).toEqual({ text: 'plain words' });
  });
  it('keeps multiple or non-text blocks verbatim', () => {
    const blocks = [
      { type: 'text' as const, text: 'a' },
      { type: 'text' as const, text: 'b' },
    ];
    expect(extractValue({ content: blocks })).toEqual({ content: blocks });
  });
});

describe('interpretResult', () => {
  it('returns value and credit cost, null when the server sends none', () => {
    expect(interpretResult({ content: [{ type: 'text', text: '{"a":1}' }], _meta: { creditCost: 3 } }, 't')).toEqual({ value: { a: 1 }, creditCost: 3 });
    expect(creditCostOf({ content: [] })).toBeNull();
    expect(creditCostOf({ content: [], _meta: { creditCost: 0 } })).toBe(0);
  });
  it('maps isError to tool_error', () => {
    expect(() => interpretResult({ isError: true, content: [{ type: 'text', text: 'Error executing x: nope' }] }, 'x')).toThrowError(/nope/);
  });
  it('maps _meta.errorCode credit_limit_exceeded to its own code, never matching prose', () => {
    try {
      interpretResult({ isError: true, content: [{ type: 'text', text: 'Out of credits. Do not retry this tool call.' }], _meta: { errorCode: 'credit_limit_exceeded' } }, 'x');
    } catch (err) {
      expect((err as HgiError).code).toBe('credit_limit_exceeded');
    }
    try {
      interpretResult({ isError: true, content: [{ type: 'text', text: 'credit_limit_exceeded' }] }, 'x');
    } catch (err) {
      expect((err as HgiError).code).toBe('tool_error');
    }
  });
});

describe('redaction happens before truncation of tool error text', () => {
  it('a secret straddling the 2000-character cut is never printed', () => {
    const token = 'tok_straddle_0123456789abcdef'; // gitleaks:allow
    registerSecret(token);
    try {
      const text = `${'x'.repeat(1990)}${token} trailing`;
      try {
        interpretResult({ isError: true, content: [{ type: 'text', text }] }, 't');
        throw new Error('should throw');
      } catch (err) {
        const message = (err as HgiError).message;
        expect(message).not.toContain(token.slice(0, 10));
        expect(message).not.toContain(token.slice(-10));
        expect(message.length).toBeLessThanOrEqual(2000);
      }
    } finally {
      clearSecrets();
    }
  });
});

describe('interpretResult: server refusal codes (decided by _meta.errorCode only)', () => {
  const refuse = (errorCode: unknown, text = 'Refused.'): HgiError => {
    try {
      interpretResult({ isError: true, content: [{ type: 'text', text }], _meta: { errorCode } }, 'company_lookup');
    } catch (err) {
      return err as HgiError;
    }
    throw new Error('expected interpretResult to throw');
  };

  it.each([
    ['credit_limit_exceeded', 'credit_limit_exceeded', 6],
    ['user_credit_limit_exceeded', 'user_credit_limit_exceeded', 6],
    ['governance_unavailable', 'governance_unavailable', 7],
    ['tool_not_enabled_for_team', 'tool_not_enabled_for_team', 11],
    ['phoenix_account_required', 'phoenix_account_required', 4],
    ['something_new', 'tool_error', 3],
  ])('%s → %s, exit %i, with details.tool and details.server_error_code', (server, code, exit) => {
    const err = refuse(server);
    expect(err.code).toBe(code);
    expect(err.exitCode).toBe(exit);
    expect(err.details?.tool).toBe('company_lookup');
    expect(err.details?.server_error_code).toBe(server);
  });

  it('keeps the organization hint for credit_limit_exceeded', () => {
    expect(refuse('credit_limit_exceeded').hint).toBe('Your organization has used its credit allowance. Contact your admin; retrying will not help.');
  });

  it('names the personal budget for user_credit_limit_exceeded and says retrying will not help', () => {
    const hint = refuse('user_credit_limit_exceeded').hint ?? '';
    expect(hint).toMatch(/personal credit budget/);
    expect(hint).toMatch(/retrying will not help/);
  });

  it('marks governance_unavailable retryable, with nothing run', () => {
    const err = refuse('governance_unavailable');
    expect(err.details).toMatchObject({ retryable: true, outcome_unknown: false });
    expect(err.hint).toMatch(/retry/i);
  });

  it('tells a phoenix_account_required user to sign up or sign in differently', () => {
    const hint = refuse('phoenix_account_required').hint ?? '';
    expect(hint).toMatch(/sign up/i);
    expect(hint).toContain('hgi auth login');
  });

  it('never matches prose, a non-string code, or a prototype key', () => {
    let err: HgiError | undefined;
    try {
      interpretResult({ isError: true, content: [{ type: 'text', text: 'governance_unavailable: user_credit_limit_exceeded' }] }, 'x');
    } catch (e) {
      err = e as HgiError;
    }
    expect(err?.code).toBe('tool_error');
    expect(err?.details).toEqual({ tool: 'x' });
    expect(refuse(42).code).toBe('tool_error');
    expect(refuse(42).details).toEqual({ tool: 'company_lookup' });
    for (const proto of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) {
      const e = refuse(proto);
      expect(e.code).toBe('tool_error');
      expect(e.details?.server_error_code).toBe(proto);
    }
  });
});

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import type { RetryEvent } from '../../src/commands/io.js';
import { sendWithRetry, type SendOptions } from '../../src/commands/retry.js';
import { HgiError } from '../../src/errors.js';
import type { McpSession } from '../../src/mcp/session.js';

const governance = (cost: number | null = null): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: 'Could not check your budget.' }],
  _meta: { errorCode: 'governance_unavailable', ...(cost !== null ? { creditCost: cost } : {}) },
});
const ok: CallToolResult = { content: [{ type: 'text', text: '{"ok":1}' }], _meta: { creditCost: 2 } };
const refusal = (code: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text: 'no' }], _meta: { errorCode: code } });

function fakeSession(results: CallToolResult[], extraSendsPerCall = 0): McpSession & { calls: number } {
  const session = {
    calls: 0,
    state: { mcpVersion: null, toolsCallWritten: false, toolsCallSends: 0 },
    serverInfo: null,
    listTools: async () => [],
    close: async () => undefined,
    async callTool() {
      session.calls += 1;
      session.state.toolsCallSends += 1 + extraSendsPerCall;
      const next = results.shift();
      if (!next) throw new Error('no more scripted results');
      return next;
    },
  };
  return session;
}

function harness(retries: number, budgetMs = 600_000, random = () => 1) {
  let clock = 0;
  const waits: number[] = [];
  const reports: RetryEvent[] = [];
  const recorded: CallToolResult[] = [];
  const opts: SendOptions = {
    retries,
    budgetMs,
    record: async (r) => {
      recorded.push(r);
      return null;
    },
    report: (e) => reports.push(e),
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    now: () => clock,
    random,
  };
  return { opts, waits, reports, recorded };
}

describe('sendWithRetry: governance_unavailable re-sends', () => {
  it('re-sends twice then returns the result; full-jitter waits within [0, 2] and [0, 4] s; every attempt recorded', async () => {
    const session = fakeSession([governance(), governance(), ok]);
    const draws = [0.25, 0.75];
    const h = harness(3, 600_000, () => draws.shift() ?? 0);
    const out = await sendWithRetry(session, 't', {}, h.opts);
    expect(out.result).toBe(ok);
    expect(out.attempts).toBe(3);
    expect(session.calls).toBe(3);
    expect(h.waits).toEqual([500, 3000]);
    expect(h.reports).toEqual([
      { attempt: 1, max: 3, code: 'governance_unavailable', wait_seconds: 0.5 },
      { attempt: 2, max: 3, code: 'governance_unavailable', wait_seconds: 3 },
    ]);
    expect(h.recorded).toHaveLength(3);
  });
  it('the waits are bounded by min(2^attempt, 30) seconds', async () => {
    const session = fakeSession([...Array.from({ length: 7 }, () => governance()), ok]);
    const h = harness(7, 3_600_000, () => 1);
    await sendWithRetry(session, 't', {}, h.opts);
    expect(h.waits).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });
  it('stops after N retries and returns the last refusal; attempts = N + 1', async () => {
    const session = fakeSession([governance(), governance(), governance(), ok]);
    const h = harness(2);
    const out = await sendWithRetry(session, 't', {}, h.opts);
    expect(out.result._meta?.errorCode).toBe('governance_unavailable');
    expect(out.attempts).toBe(3);
    expect(h.reports).toHaveLength(2);
    expect(h.recorded).toHaveLength(3);
  });
  it('retries 0 sends exactly once (hgi run, or hgi call without --retries)', async () => {
    const session = fakeSession([governance(), ok]);
    const h = harness(0);
    const out = await sendWithRetry(session, 't', {}, h.opts);
    expect(session.calls).toBe(1);
    expect(out.attempts).toBe(1);
    expect(h.waits).toEqual([]);
  });
  it('a wait longer than what is left of the budget ends the retries, without waiting', async () => {
    const session = fakeSession([governance(), governance(), ok]);
    const h = harness(5, 3000, () => 1);
    const out = await sendWithRetry(session, 't', {}, h.opts);
    expect(h.waits).toEqual([2000]);
    expect(session.calls).toBe(2);
    expect(out.result._meta?.errorCode).toBe('governance_unavailable');
  });
  it('the run cap is checked after the wait, right before the re-send: a cap reached during the wait sends nothing more', async () => {
    const session = fakeSession([governance(), ok]);
    const h = harness(3);
    let capReached = false;
    const sleep = h.opts.sleep;
    h.opts.sleep = async (ms) => {
      await sleep?.(ms);
      capReached = true;
    };
    h.opts.beforeResend = async () => {
      if (capReached) throw new HgiError('budget_exceeded', 'cap');
    };
    await expect(sendWithRetry(session, 't', {}, h.opts)).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(session.calls).toBe(1);
    expect(h.recorded).toHaveLength(1);
  });
  it('a failed spend record stops the retries and is returned', async () => {
    const session = fakeSession([governance(), ok]);
    const h = harness(3);
    const failure = new HgiError('local_state_error', 'Could not record');
    h.opts.record = async () => failure;
    const out = await sendWithRetry(session, 't', {}, h.opts);
    expect(session.calls).toBe(1);
    expect(out.budgetFailure).toBe(failure);
  });
  for (const code of ['credit_limit_exceeded', 'user_credit_limit_exceeded', 'tool_not_enabled_for_team', 'phoenix_account_required', 'something_new']) {
    it(`${code} is never re-sent`, async () => {
      const session = fakeSession([refusal(code), ok]);
      const out = await sendWithRetry(session, 't', {}, harness(6).opts);
      expect(session.calls).toBe(1);
      expect(out.attempts).toBe(1);
    });
  }
  it('a plain tool_error (isError without a code) and a message naming the code are never re-sent', async () => {
    const named: CallToolResult = { isError: true, content: [{ type: 'text', text: 'governance_unavailable' }] };
    const session = fakeSession([named, ok]);
    await sendWithRetry(session, 't', {}, harness(6).opts);
    expect(session.calls).toBe(1);
  });
  it('attempts counts transport-level sends too', async () => {
    const session = fakeSession([ok], 1);
    const out = await sendWithRetry(session, 't', {}, harness(3).opts);
    expect(out.attempts).toBe(2);
  });
  it('a transport error propagates and is not retried', async () => {
    const session = fakeSession([]);
    session.callTool = async () => {
      session.calls += 1;
      throw new HgiError('server_unreachable', 'reset', { details: { outcome_unknown: true } });
    };
    await expect(sendWithRetry(session, 't', {}, harness(6).opts)).rejects.toMatchObject({ details: { outcome_unknown: true } });
    expect(session.calls).toBe(1);
  });
});

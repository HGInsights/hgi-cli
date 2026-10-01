import { describe, expect, it } from 'vitest';
import type { AuthedFetch } from '../../src/authed-fetch.js';
import { HgiError } from '../../src/errors.js';
import { mapMcpError } from '../../src/mcp/session.js';
import { createTransportFetch, type TransportState } from '../../src/mcp/transport-fetch.js';

type Step = Response | HgiError;

function harness(steps: Step[], startTime = 0) {
  const calls: string[] = [];
  const waits: number[] = [];
  let clock = startTime;
  const authed: AuthedFetch = async (_url, init) => {
    calls.push(JSON.parse(String(init?.body ?? '{}')).method ?? String(init?.method));
    const step = steps.shift();
    if (!step) throw new Error('no more scripted steps');
    if (step instanceof HgiError) throw step;
    return step as never;
  };
  const state: TransportState = { mcpVersion: null, toolsCallWritten: false };
  const fetchFn = createTransportFetch(authed, state, {
    timeoutMs: 1000,
    sleepFn: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    now: () => clock,
    random: () => 0,
  });
  return { fetchFn, calls, waits, state };
}

const post = (method: string) => ({ method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }) });
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const unreachable = (cause: string) => new HgiError('server_unreachable', 'x', { details: { cause } });

describe('429 handling', () => {
  it('honors Retry-After then succeeds', async () => {
    const h = harness([json(429, {}, { 'retry-after': '2' }), json(200, { ok: 1 })]);
    const res = await h.fetchFn('http://x', post('tools/call'));
    expect(res.status).toBe(200);
    expect(h.waits[0]).toBe(2000);
    expect(h.calls).toHaveLength(2);
  });
  it('falls back to doubling delays without Retry-After and gives up with rate_limited', async () => {
    const h = harness([json(429, {}), json(429, {}), json(429, {}), json(429, {})]);
    await expect(h.fetchFn('http://x', post('tools/list'))).rejects.toMatchObject({ code: 'rate_limited' });
    expect(h.waits).toEqual([2000, 4000, 8000]);
  });
  it('fails fast when Retry-After exceeds the remaining budget', async () => {
    const h = harness([json(429, {}, { 'retry-after': '120' })]);
    await expect(h.fetchFn('http://x', post('tools/call'))).rejects.toMatchObject({
      code: 'rate_limited',
      details: { retry_after_seconds: 120 },
    });
    expect(h.waits).toEqual([]);
  });
});

describe('tools/call is never retried after dispatch', () => {
  it('does not retry a connection reset and marks outcome_unknown', async () => {
    const h = harness([unreachable('ECONNRESET'), json(200, {})]);
    await expect(h.fetchFn('http://x', post('tools/call'))).rejects.toMatchObject({
      code: 'server_unreachable',
      details: { outcome_unknown: true },
    });
    expect(h.calls).toHaveLength(1);
  });
  it('does not retry a 500 or 502 and marks outcome_unknown', async () => {
    for (const status of [500, 502, 504]) {
      const h = harness([json(status, {}), json(200, {})]);
      await expect(h.fetchFn('http://x', post('tools/call'))).rejects.toMatchObject({ details: { outcome_unknown: true, status } });
      expect(h.calls).toHaveLength(1);
    }
  });
  it('retries connection-refused before dispatch', async () => {
    const h = harness([unreachable('ECONNREFUSED'), json(200, {})]);
    expect((await h.fetchFn('http://x', post('tools/call'))).status).toBe(200);
    expect(h.calls).toHaveLength(2);
  });
  it('retries the Phoenix shed signature (503 + -32000 + Retry-After) and reports outcome_unknown false when exhausted', async () => {
    const shed = () => json(503, { jsonrpc: '2.0', error: { code: -32000, message: 'busy' }, id: null }, { 'retry-after': '1' });
    const ok = harness([shed(), json(200, {})]);
    expect((await ok.fetchFn('http://x', post('tools/call'))).status).toBe(200);
    const bad = harness([shed(), shed(), shed(), shed()]);
    await expect(bad.fetchFn('http://x', post('tools/call'))).rejects.toMatchObject({
      code: 'server_unreachable',
      details: { outcome_unknown: false },
    });
  });
  it('a 503 without the shed signature is post-dispatch for tools/call', async () => {
    const h = harness([json(503, { error: 'x' }), json(200, {})]);
    await expect(h.fetchFn('http://x', post('tools/call'))).rejects.toMatchObject({ details: { outcome_unknown: true } });
  });
});

describe('abort signal from the SDK', () => {
  it('stops retrying after the SDK aborted the request, so a timed-out tools/call is never re-sent', async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const authed: AuthedFetch = async (_url, init) => {
      calls.push(String(init?.method));
      return json(429, {}, { 'retry-after': '1' }) as never;
    };
    const fetchFn = createTransportFetch(authed, { mcpVersion: null, toolsCallWritten: false }, {
      timeoutMs: 1000,
      sleepFn: async (_ms, signal) => {
        controller.abort(new Error('sdk timeout'));
        if (signal?.aborted) throw signal.reason;
      },
    });
    await expect(fetchFn('http://x', { ...post('tools/call'), signal: controller.signal })).rejects.toThrow('sdk timeout');
    expect(calls).toHaveLength(1);
  });
  it('does not even send when already aborted', async () => {
    const h = harness([json(200, {})]);
    const controller = new AbortController();
    controller.abort(new Error('gone'));
    await expect(h.fetchFn('http://x', { ...post('tools/call'), signal: controller.signal })).rejects.toThrow('gone');
    expect(h.calls).toHaveLength(0);
  });
});

describe('non-call requests', () => {
  it('retries transient failures and 502/503/504 a bounded number of times', async () => {
    const h = harness([unreachable('ECONNRESET'), json(502, {}), json(200, {})]);
    expect((await h.fetchFn('http://x', post('tools/list'))).status).toBe(200);
    const bad = harness([json(502, {}), json(502, {}), json(502, {})]);
    await expect(bad.fetchFn('http://x', post('initialize'))).rejects.toMatchObject({ code: 'server_unreachable' });
  });
  it('maps 403 to forbidden and passes 4xx like 405 through for GET streams', async () => {
    await expect(harness([json(403, {})]).fetchFn('http://x', post('tools/list'))).rejects.toMatchObject({ code: 'forbidden' });
    const res = await harness([new Response(null, { status: 405 })]).fetchFn('http://x', { method: 'GET' });
    expect(res.status).toBe(405);
  });
  it('captures X-MCP-Version', async () => {
    const h = harness([json(200, {}, { 'x-mcp-version': 'v2' })]);
    await h.fetchFn('http://x', post('tools/list'));
    expect(h.state.mcpVersion).toBe('v2');
  });
});

describe('mapMcpError marks every post-dispatch network-class failure outcome_unknown', () => {
  const written = { mcpVersion: null, toolsCallWritten: true };
  const notWritten = { mcpVersion: null, toolsCallWritten: false };
  it('a proxy-classified failure after tools/call was sent is outcome_unknown, not a "fix your proxy and retry"', () => {
    const err = mapMcpError(new HgiError('network_proxy_tls', 'proxy reset', { details: { cause: 'ECONNRESET', proxy: 'p:1' } }), written);
    expect(err.code).toBe('network_proxy_tls');
    expect(err.details?.outcome_unknown).toBe(true);
    expect(err.hint).toContain('may or may not have run');
  });
  it('a raw TypeError from undici (connection dropped mid-body) is outcome_unknown', () => {
    const raw = Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } });
    expect(mapMcpError(raw, written).details?.outcome_unknown).toBe(true);
    const unclassified = mapMcpError(new TypeError('something odd'), written);
    expect(unclassified.details?.outcome_unknown).toBe(true);
  });
  it('an exhausted pre-dispatch shed keeps outcome_unknown false, and nothing is marked before tools/call', () => {
    const shed = new HgiError('server_unreachable', 'shed', { details: { outcome_unknown: false } });
    expect(mapMcpError(shed, written).details?.outcome_unknown).toBe(false);
    expect(mapMcpError(new HgiError('server_unreachable', 'x'), notWritten).details?.outcome_unknown).toBeUndefined();
  });
});

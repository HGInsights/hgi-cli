import { describe, expect, it } from 'vitest';
import type { AuthedFetch } from '../../src/authed-fetch.js';
import { HgiError } from '../../src/errors.js';
import { mapMcpError } from '../../src/mcp/session.js';
import { sdkTimeoutMs } from '../../src/mcp/session.js';
import {
  createTransportFetch,
  maxHttpSends,
  retryLimits,
  type TransportFetchOptions,
  type TransportRetryEvent,
  type TransportState,
} from '../../src/mcp/transport-fetch.js';

type Step = Response | HgiError;

function harness(steps: Step[], startTime = 0, extra: Partial<TransportFetchOptions> = {}) {
  const calls: string[] = [];
  const waits: number[] = [];
  const events: TransportRetryEvent[] = [];
  let clock = startTime;
  const authed: AuthedFetch = async (_url, init) => {
    calls.push(JSON.parse(String(init?.body ?? '{}')).method ?? String(init?.method));
    const step = steps.shift();
    if (!step) throw new Error('no more scripted steps');
    if (step instanceof HgiError) throw step;
    return step as never;
  };
  const state: TransportState = { mcpVersion: null, toolsCallWritten: false, toolsCallSends: 0 };
  const fetchFn = createTransportFetch(authed, state, {
    timeoutMs: 1000,
    sleepFn: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    now: () => clock,
    random: () => 0,
    onRetry: (e) => events.push(e),
    ...extra,
  });
  return { fetchFn, calls, waits, state, events };
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
    const fetchFn = createTransportFetch(authed, { mcpVersion: null, toolsCallWritten: false, toolsCallSends: 0 }, {
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
  const written = { mcpVersion: null, toolsCallWritten: true, toolsCallSends: 0 };
  const notWritten = { mcpVersion: null, toolsCallWritten: false, toolsCallSends: 0 };
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

describe('--retries / --retry-budget (issue #32)', () => {
  const shed = () => json(503, { jsonrpc: '2.0', error: { code: -32000, message: 'busy' }, id: null }, { 'retry-after': '1' });
  const refused = () => unreachable('ECONNREFUSED');
  const ok = () => json(200, {});

  it('rides out four 429s with Retry-After: 50 (200 s of waits, inside the 600 s default budget)', async () => {
    const h = harness([...Array.from({ length: 4 }, () => json(429, {}, { 'retry-after': '50' })), ok()], 0, { retries: 6 });
    expect((await h.fetchFn('http://x', post('tools/call'))).status).toBe(200);
    expect(h.waits).toEqual([50_000, 50_000, 50_000, 50_000]);
    expect(h.state.toolsCallSends).toBe(5);
  });
  it('the same 429s without --retries end with rate_limited once the 60 s budget cannot fit the next wait, as before', async () => {
    const h = harness(Array.from({ length: 4 }, () => json(429, {}, { 'retry-after': '50' })));
    await expect(h.fetchFn('http://x', post('tools/call'))).rejects.toMatchObject({ code: 'rate_limited', details: { attempts: 2 } });
    expect(h.waits).toEqual([50_000]);
  });
  it('rides out five load-shed 503s and five refused connections', async () => {
    const a = harness([shed(), shed(), shed(), shed(), shed(), ok()], 0, { retries: 6 });
    expect((await a.fetchFn('http://x', post('tools/call'))).status).toBe(200);
    expect(a.events.map((e) => e.code)).toEqual(Array(5).fill('load_shed'));
    const b = harness([refused(), refused(), refused(), refused(), refused(), ok()], 0, { retries: 6 });
    expect((await b.fetchFn('http://x', post('tools/call'))).status).toBe(200);
    expect(b.waits).toEqual([500, 1000, 1500, 2000, 2500]);
    expect(b.events.map((e) => e.code)).toEqual(Array(5).fill('not_established'));
  });
  it('counts each class separately: 3 refused, 3 load-shed and 3 429s, then success, with --retries 3', async () => {
    const h = harness([refused(), refused(), refused(), shed(), shed(), shed(), json(429, {}), json(429, {}), json(429, {}), ok()], 0, {
      retries: 3,
    });
    expect((await h.fetchFn('http://x', post('tools/call'))).status).toBe(200);
    expect(h.events.map((e) => `${e.code}:${e.attempt}/${e.max}`)).toEqual([
      'not_established:1/3',
      'not_established:2/3',
      'not_established:3/3',
      'load_shed:1/3',
      'load_shed:2/3',
      'load_shed:3/3',
      'rate_limited:1/3',
      'rate_limited:2/3',
      'rate_limited:3/3',
    ]);
  });
  it('without --retries, 429 and load-shed share one counter of 3 and the line reports max 3', async () => {
    const h = harness([json(429, {}, { 'retry-after': '1' }), shed(), json(429, {}, { 'retry-after': '1' }), shed()]);
    await expect(h.fetchFn('http://x', post('tools/call'))).rejects.toMatchObject({
      code: 'server_unreachable',
      details: { outcome_unknown: false, attempts: 4 },
    });
    expect(h.events.map((e) => `${e.code}:${e.attempt}/${e.max}`)).toEqual(['rate_limited:1/3', 'load_shed:2/3', 'rate_limited:3/3']);
  });
  it('--retry-budget 120: a Retry-After longer than what is left ends the retries at once', async () => {
    const h = harness([json(429, {}, { 'retry-after': '100' }), json(429, {}, { 'retry-after': '30' })], 0, {
      retries: 6,
      retryBudgetMs: 120_000,
    });
    await expect(h.fetchFn('http://x', post('tools/call'))).rejects.toMatchObject({
      code: 'rate_limited',
      details: { retry_after_seconds: 30, attempts: 2 },
    });
    expect(h.waits).toEqual([100_000]);
  });
  it('--retries set and no --retry-budget: the budget is 600 s', async () => {
    const fits = harness([json(429, {}, { 'retry-after': '599' }), ok()], 0, { retries: 1 });
    expect((await fits.fetchFn('http://x', post('tools/call'))).status).toBe(200);
    const over = harness([json(429, {}, { 'retry-after': '601' })], 0, { retries: 1 });
    await expect(over.fetchFn('http://x', post('tools/call'))).rejects.toMatchObject({ code: 'rate_limited', details: { attempts: 1 } });
    expect(over.waits).toEqual([]);
  });
  it('--retry-budget alone raises the budget and keeps the built-in counts', async () => {
    const h = harness([json(429, {}, { 'retry-after': '100' }), json(429, {}, { 'retry-after': '100' }), ok()], 0, {
      retryBudgetMs: 600_000,
    });
    expect((await h.fetchFn('http://x', post('tools/call'))).status).toBe(200);
    expect(h.events.map((e) => e.max)).toEqual([3, 3]);
  });
  it('--retry-budget alone also bounds the not-established waits; without options they are not budget-checked, as before', async () => {
    const h = harness([refused(), refused(), ok()], 0, { retryBudgetMs: 1000 });
    await expect(h.fetchFn('http://x', post('tools/call'))).rejects.toMatchObject({ code: 'server_unreachable', details: { attempts: 2 } });
    expect(h.waits).toEqual([500]);
    const none = harness([refused(), refused(), ok()], 0, {});
    expect((await none.fetchFn('http://x', post('tools/call'))).status).toBe(200);
    expect(none.waits).toEqual([500, 1000]);
  });
  it('--retries 0: a single 429 is rate_limited with no wait, a single refused connection is server_unreachable', async () => {
    const a = harness([json(429, {}, { 'retry-after': '1' }), ok()], 0, { retries: 0 });
    await expect(a.fetchFn('http://x', post('tools/call'))).rejects.toMatchObject({ code: 'rate_limited', details: { attempts: 1 } });
    expect(a.waits).toEqual([]);
    const b = harness([refused(), ok()], 0, { retries: 0 });
    await expect(b.fetchFn('http://x', post('tools/call'))).rejects.toMatchObject({ code: 'server_unreachable', details: { attempts: 1 } });
    expect(b.calls).toHaveLength(1);
    const c = harness([shed(), ok()], 0, { retries: 0 });
    await expect(c.fetchFn('http://x', post('tools/list'))).rejects.toMatchObject({
      code: 'server_unreachable',
      details: { outcome_unknown: false },
    });
    const d = harness([json(502, {}), ok()], 0, { retries: 0 });
    await expect(d.fetchFn('http://x', post('tools/list'))).rejects.toMatchObject({ code: 'server_unreachable' });
    expect(d.calls).toHaveLength(1);
  });
  it('never retries after a tools/call was sent, whatever --retries says', async () => {
    for (const step of [unreachable('ECONNRESET'), json(500, {}), json(502, {}), json(503, { error: 'x' })]) {
      const h = harness([step, ok()], 0, { retries: 6 });
      await expect(h.fetchFn('http://x', post('tools/call'))).rejects.toMatchObject({ details: { outcome_unknown: true } });
      expect(h.calls).toHaveLength(1);
      expect(h.events).toEqual([]);
    }
  });
  it('a TLS or proxy failure (exit 9) is never retried', async () => {
    const tls = new HgiError('network_proxy_tls', 'TLS verification failed', { details: { cause: 'SELF_SIGNED_CERT_IN_CHAIN' } });
    for (const method of ['tools/call', 'tools/list']) {
      const h = harness([tls, ok()], 0, { retries: 6 });
      await expect(h.fetchFn('http://x', post(method))).rejects.toMatchObject({ code: 'network_proxy_tls' });
      expect(h.calls).toHaveLength(1);
    }
  });
  it('reports the wait it actually sleeps, jitter included, and keeps both random draws of the no-Retry-After backoff', async () => {
    const h = harness([json(429, {}), ok()], 0, { random: () => 0.5 });
    expect((await h.fetchFn('http://x', post('tools/call'))).status).toBe(200);
    expect(h.waits).toEqual([(2 + 0.5) * 1000 + 0.5 * 250]);
    expect(h.events).toEqual([{ attempt: 1, max: 3, code: 'rate_limited', wait_seconds: 2.6 }]);
    const shedWait = harness([shed(), ok()], 0, { random: () => 0.5 });
    await shedWait.fetchFn('http://x', post('tools/call'));
    expect(shedWait.waits).toEqual([1125]);
    expect(shedWait.events[0]?.wait_seconds).toBe(1.1);
  });
  it('counts tools/call sends only, not other requests', async () => {
    const h = harness([json(429, {}, { 'retry-after': '1' }), ok(), ok()]);
    await h.fetchFn('http://x', post('tools/call'));
    await h.fetchFn('http://x', post('tools/list'));
    expect(h.state.toolsCallSends).toBe(2);
  });
});

describe('the SDK timeout is a backstop over the transport worst case', () => {
  it('exceeds every send at the per-attempt timeout plus the whole budget', () => {
    for (const retry of [{}, { retries: 0 }, { retries: 6 }, { retries: 20, retryBudgetMs: 3_600_000 }, { retryBudgetMs: 600_000 }]) {
      const limits = retryLimits(retry);
      const sends = maxHttpSends(limits);
      expect(sdkTimeoutMs(120_000, retry)).toBeGreaterThan(120_000 * sends + limits.budgetMs + 250 * sends);
    }
  });
  it('counts every class: 2 × (1 + 3 + 2) sends by default, 2 × (1 + 3 × N) with --retries N', () => {
    expect(maxHttpSends(retryLimits({}))).toBe(12);
    expect(maxHttpSends(retryLimits({ retries: 6 }))).toBe(38);
  });
});

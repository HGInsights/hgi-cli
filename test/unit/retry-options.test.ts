import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportRetry } from '../../src/commands/io.js';
import { resolveRetryOptions } from '../../src/commands/retry-options.js';
import { HgiError } from '../../src/errors.js';

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof HgiError) return err.details?.reason as string | undefined;
    throw err;
  }
  return undefined;
}

describe('resolveRetryOptions', () => {
  it('neither option: both null, so the transport keeps its built-in limits', () => {
    expect(resolveRetryOptions({}, {})).toEqual({ retries: null, retryBudgetMs: null });
  });
  it('the flags win over the env vars', () => {
    expect(resolveRetryOptions({ retries: '1', retryBudget: '30' }, { HGI_RETRIES: '6', HGI_RETRY_BUDGET: '900' })).toEqual({
      retries: 1,
      retryBudgetMs: 30_000,
    });
  });
  it('the env vars apply alone', () => {
    expect(resolveRetryOptions({}, { HGI_RETRIES: '6' })).toEqual({ retries: 6, retryBudgetMs: null });
    expect(resolveRetryOptions({}, { HGI_RETRY_BUDGET: '120' })).toEqual({ retries: null, retryBudgetMs: 120_000 });
  });
  it('--retry-budget alone is allowed, and an explicit 60 is kept apart from "not given"', () => {
    expect(resolveRetryOptions({ retryBudget: '60' }, {})).toEqual({ retries: null, retryBudgetMs: 60_000 });
    expect(resolveRetryOptions({ retryBudget: '0.5' }, {})).toEqual({ retries: null, retryBudgetMs: 500 });
  });
  it('an empty env var counts as unset', () => {
    expect(resolveRetryOptions({}, { HGI_RETRIES: '', HGI_RETRY_BUDGET: '' })).toEqual({ retries: null, retryBudgetMs: null });
  });
  it('accepts 0 and 20 retries, and a 3600 s budget', () => {
    expect(resolveRetryOptions({ retries: '0', retryBudget: '3600' }, {})).toEqual({ retries: 0, retryBudgetMs: 3_600_000 });
    expect(resolveRetryOptions({ retries: '20' }, {}).retries).toBe(20);
  });
  for (const bad of ['-1', '21', '2.5', 'x', '', ' ', '1e1', '0x2']) {
    it(`--retries ${JSON.stringify(bad)} and HGI_RETRIES=${JSON.stringify(bad)} are bad_retries`, () => {
      expect(reasonOf(() => resolveRetryOptions({ retries: bad }, {}))).toBe('bad_retries');
      if (bad !== '') expect(reasonOf(() => resolveRetryOptions({}, { HGI_RETRIES: bad }))).toBe('bad_retries');
    });
  }
  for (const bad of ['0', '-5', '3601', 'x', '', 'Infinity', 'NaN']) {
    it(`--retry-budget ${JSON.stringify(bad)} and HGI_RETRY_BUDGET=${JSON.stringify(bad)} are bad_retry_budget`, () => {
      expect(reasonOf(() => resolveRetryOptions({ retryBudget: bad }, {}))).toBe('bad_retry_budget');
      if (bad !== '') expect(reasonOf(() => resolveRetryOptions({}, { HGI_RETRY_BUDGET: bad }))).toBe('bad_retry_budget');
    });
  }
  it('never echoes the bad value (a token pasted into the wrong place)', () => {
    const secret = 'at_0123456789abcdef0123456789abcdef';
    for (const fn of [
      () => resolveRetryOptions({ retries: secret }, {}),
      () => resolveRetryOptions({}, { HGI_RETRIES: secret }),
      () => resolveRetryOptions({ retryBudget: secret }, {}),
      () => resolveRetryOptions({}, { HGI_RETRY_BUDGET: secret }),
    ]) {
      try {
        fn();
        expect.unreachable();
      } catch (err) {
        expect(JSON.stringify({ m: (err as HgiError).message, h: (err as HgiError).hint, d: (err as HgiError).details })).not.toContain(secret);
      }
    }
  });
});

describe('reportRetry', () => {
  let written = '';
  const argv = process.argv;
  beforeEach(() => {
    written = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      written += chunk;
      return true;
    }) as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.argv = argv;
    Object.defineProperty(process.stderr, 'isTTY', { value: undefined, configurable: true });
  });
  const event = { attempt: 2, max: 6, code: 'rate_limited' as const, wait_seconds: 12 };

  it('prints one JSON line when stderr is not a terminal', () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: undefined, configurable: true });
    reportRetry(event);
    expect(written).toBe('{"retry":{"attempt":2,"max":6,"code":"rate_limited","wait_seconds":12}}\n');
  });
  it('prints the plain form on a terminal', () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    reportRetry({ ...event, wait_seconds: 1.5 });
    expect(written).toBe('hgi: retry 2/6: rate_limited, waiting 1.5s\n');
  });
  it('prints JSON on a terminal with --json-errors', () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    process.argv = [...argv, '--json-errors'];
    reportRetry(event);
    expect(JSON.parse(written)).toEqual({ retry: event });
  });
});

import { describe, expect, it } from 'vitest';
import { evaluateCallbackParams, parsePastedCallback } from '../../src/auth/callback.js';
import { challengeS256, randomUrlSafe } from '../../src/auth/pkce.js';
import { HgiError } from '../../src/errors.js';

const redirectUri = 'http://127.0.0.1:51234/callback';
const state = 'state-abc';

function expectOauth(fn: () => unknown, reason: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HgiError);
    expect((err as HgiError).code).toBe('oauth_error');
    expect((err as HgiError).details?.reason).toBe(reason);
    return;
  }
  throw new Error('expected a throw');
}

describe('pkce', () => {
  it('matches the RFC 7636 S256 vector', () => {
    expect(challengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
  it('produces 43+ char url-safe verifiers', () => {
    expect(randomUrlSafe(32)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('evaluateCallbackParams', () => {
  it('accepts exact state and a single code', () => {
    expect(evaluateCallbackParams(new URLSearchParams({ state, code: 'c1' }), state)).toBe('c1');
  });
  it('rejects a wrong or missing state', () => {
    expectOauth(() => evaluateCallbackParams(new URLSearchParams({ state: 'nope', code: 'c1' }), state), 'state_mismatch');
    expectOauth(() => evaluateCallbackParams(new URLSearchParams({ code: 'c1' }), state), 'state_mismatch');
  });
  it('rejects duplicated parameters', () => {
    expectOauth(() => evaluateCallbackParams(new URLSearchParams('state=state-abc&state=state-abc&code=c'), state), 'state_mismatch');
    expectOauth(() => evaluateCallbackParams(new URLSearchParams('state=state-abc&code=a&code=b'), state), 'missing_code');
  });
  it('reports an OAuth error response, state still checked first', () => {
    expectOauth(() => evaluateCallbackParams(new URLSearchParams({ state, error: 'access_denied' }), state), 'access_denied');
  });
});

describe('parsePastedCallback', () => {
  const good = `${redirectUri}?code=c1&state=${state}`;
  it('accepts the exact redirect URI and state, once', () => {
    const used = { value: false };
    expect(parsePastedCallback(good, { redirectUri, state }, used)).toBe('c1');
    expectOauth(() => parsePastedCallback(good, { redirectUri, state }, used), 'callback_reused');
  });
  it('rejects a different port, host, path or scheme', () => {
    for (const bad of [
      'http://127.0.0.1:51235/callback',
      'http://localhost:51234/callback',
      'http://127.0.0.1:51234/other',
      'https://127.0.0.1:51234/callback',
    ]) {
      expectOauth(() => parsePastedCallback(`${bad}?code=c1&state=${state}`, { redirectUri, state }, { value: false }), 'redirect_mismatch');
    }
  });
  it('rejects a wrong state and garbage input', () => {
    expectOauth(() => parsePastedCallback(`${redirectUri}?code=c1&state=zzz`, { redirectUri, state }, { value: false }), 'state_mismatch');
    expectOauth(() => parsePastedCallback('not a url', { redirectUri, state }, { value: false }), 'invalid_url');
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { clearSecrets, redact, redactDeep, registerSecret } from '../../src/redact.js';
import { ERROR_EXIT, HgiError, classifyNetworkError, renderError, toErrorBody, type ErrorCode } from '../../src/errors.js';

afterEach(() => clearSecrets());

describe('redact', () => {
  it('masks registered secret values anywhere', () => {
    registerSecret('super-secret-token-value');
    expect(redact('boom super-secret-token-value boom')).toBe('boom [REDACTED] boom');
  });
  it('masks bearer tokens, token fields and code= query params', () => {
    const text = 'Authorization: Bearer abc.def.ghi {"refresh_token":"rt_123456789"} http://x/cb?code=XYZ123&state=s'; // gitleaks:allow
    const out = redact(text);
    expect(out).not.toContain('abc.def.ghi');
    expect(out).not.toContain('rt_123456789');
    expect(out).not.toContain('XYZ123');
    expect(out).toContain('state=s');
  });
  it('does not mask by bare key name `code`, so error slugs survive', () => {
    registerSecret('rt_secret_value_1');
    const err = new HgiError('credit_limit_exceeded', 'out of credits rt_secret_value_1', {
      details: { cause: 'ECONNREFUSED' },
    });
    const body = toErrorBody(err);
    expect(body.error.code).toBe('credit_limit_exceeded');
    expect(body.error.message).not.toContain('rt_secret_value_1');
    expect(body.error.details).toEqual({ cause: 'ECONNREFUSED' });
  });
  it('every documented slug survives redaction in the JSON body', () => {
    for (const code of Object.keys(ERROR_EXIT) as ErrorCode[]) {
      const body = JSON.parse(renderError(new HgiError(code, 'm'), true)) as { error: { code: string; exit_code: number } };
      expect(body.error.code).toBe(code);
      expect(body.error.exit_code).toBe(ERROR_EXIT[code]);
    }
  });
  it('redactDeep walks nested structures', () => {
    registerSecret('deepsecret-12345');
    expect(redactDeep({ a: ['x deepsecret-12345'], b: { c: 'deepsecret-12345' } })).toEqual({
      a: ['x [REDACTED]'],
      b: { c: '[REDACTED]' },
    });
  });
});

describe('exit codes', () => {
  it('are distinct per failure class except login_required/login_expired', () => {
    const codes = Object.entries(ERROR_EXIT);
    const byExit = new Map<number, string[]>();
    for (const [slug, n] of codes) byExit.set(n, [...(byExit.get(n) ?? []), slug]);
    for (const [n, slugs] of byExit) {
      if (n === 4) expect(slugs.sort()).toEqual(['login_expired', 'login_required']);
      else expect(slugs).toHaveLength(1);
    }
  });
});

describe('classifyNetworkError', () => {
  const withCause = (code: string, message = 'fetch failed') => Object.assign(new TypeError(message), { cause: { code } });
  it('names TLS causes', () => {
    const err = classifyNetworkError(withCause('DEPTH_ZERO_SELF_SIGNED_CERT'));
    expect(err?.code).toBe('network_proxy_tls');
    expect(err?.message).toContain('DEPTH_ZERO_SELF_SIGNED_CERT');
  });
  it('names proxy causes', () => {
    expect(classifyNetworkError(withCause('UND_ERR_PRX_TLS'))?.code).toBe('network_proxy_tls');
  });
  it('maps DNS/refused/timeouts to unreachable', () => {
    expect(classifyNetworkError(withCause('ENOTFOUND'))?.code).toBe('server_unreachable');
    expect(classifyNetworkError(withCause('ECONNREFUSED'))?.code).toBe('server_unreachable');
    expect(classifyNetworkError(Object.assign(new Error('t'), { name: 'TimeoutError' }))?.code).toBe('server_unreachable');
  });
  it('returns null for unrelated errors', () => {
    expect(classifyNetworkError(new Error('boom'))).toBeNull();
  });
});

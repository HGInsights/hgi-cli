import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startLoopback, type LoopbackHandle } from '../../src/auth/loopback.js';
import { ERROR_EXIT, HgiError } from '../../src/errors.js';

let handle: LoopbackHandle | undefined;
afterEach(() => handle?.close());

function get(port: number, pathAndQuery: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathAndQuery, headers: { host }, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => (body += d.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('startLoopback', () => {
  it('advertises a localhost redirect URI, binds 127.0.0.1 only, and uses /callback', async () => {
    handle = await startLoopback({ state: 'st', timeoutMs: 10_000, base: 'https://hg.example.test' });
    expect(handle.redirectUri).toBe(`http://localhost:${handle.port}/callback`);
  });

  it('accepts both loopback Host names but refuses any other Host header (DNS rebinding) without consuming the callback', async () => {
    handle = await startLoopback({ state: 'st', timeoutMs: 10_000, base: 'https://hg.example.test' });
    const rebound = await get(handle.port, '/callback?code=c&state=st', `evil.example:${handle.port}`);
    expect(rebound.status).toBe(400);
    const wrongPath = await get(handle.port, '/other', `localhost:${handle.port}`);
    expect(wrongPath.status).toBe(404);
    const ok = await get(handle.port, '/callback?code=thecode&state=st', `localhost:${handle.port}`);
    expect(ok.status).toBe(200);
    await expect(handle.waitForCode()).resolves.toBe('thecode');
  });

  it('also accepts the 127.0.0.1 Host name, and a second callback is refused', async () => {
    handle = await startLoopback({ state: 'st', timeoutMs: 10_000, base: 'https://hg.example.test' });
    const first = await get(handle.port, '/callback?code=one&state=st', `127.0.0.1:${handle.port}`);
    expect(first.status).toBe(200);
    await expect(handle.waitForCode()).resolves.toBe('one');
    const second = await get(handle.port, '/callback?code=two&state=st', `127.0.0.1:${handle.port}`).catch(() => ({ status: 0, body: '' }));
    expect([0, 409]).toContain(second.status);
  });

  it('a callback with the wrong state ends the attempt with an oauth_error', async () => {
    handle = await startLoopback({ state: 'st', timeoutMs: 10_000, base: 'https://hg.example.test' });
    const waiting = handle.waitForCode();
    await get(handle.port, '/callback?code=c&state=forged', `localhost:${handle.port}`);
    await expect(waiting).rejects.toMatchObject({ code: 'oauth_error', details: { reason: 'state_mismatch' } });
  });

  it('a timeout keeps the oauth_error code, message, exit 8 and login_timeout reason, and its hint gives the 403 recovery', async () => {
    handle = await startLoopback({ state: 'st', timeoutMs: 50, base: 'https://hg.example.test' });
    const err = (await handle.waitForCode().catch((e: unknown) => e)) as HgiError;
    expect(err).toBeInstanceOf(HgiError);
    expect(err).toMatchObject({
      code: 'oauth_error',
      message: 'Timed out waiting for the browser sign-in to finish.',
      details: { reason: 'login_timeout' },
    });
    expect(ERROR_EXIT[err.code]).toBe(8);
    for (const part of ['403 Forbidden', 'private window', 'cookies for hg.example.test', 'sign in at https://hg.example.test first', 'hgi auth login', '--no-browser']) {
      expect(err.hint).toContain(part);
    }
  });
});

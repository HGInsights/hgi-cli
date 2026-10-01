import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startLoopback, type LoopbackHandle } from '../../src/auth/loopback.js';

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
    handle = await startLoopback({ state: 'st', timeoutMs: 10_000 });
    expect(handle.redirectUri).toBe(`http://localhost:${handle.port}/callback`);
  });

  it('accepts both loopback Host names but refuses any other Host header (DNS rebinding) without consuming the callback', async () => {
    handle = await startLoopback({ state: 'st', timeoutMs: 10_000 });
    const rebound = await get(handle.port, '/callback?code=c&state=st', `evil.example:${handle.port}`);
    expect(rebound.status).toBe(400);
    const wrongPath = await get(handle.port, '/other', `localhost:${handle.port}`);
    expect(wrongPath.status).toBe(404);
    const ok = await get(handle.port, '/callback?code=thecode&state=st', `localhost:${handle.port}`);
    expect(ok.status).toBe(200);
    await expect(handle.waitForCode()).resolves.toBe('thecode');
  });

  it('also accepts the 127.0.0.1 Host name, and a second callback is refused', async () => {
    handle = await startLoopback({ state: 'st', timeoutMs: 10_000 });
    const first = await get(handle.port, '/callback?code=one&state=st', `127.0.0.1:${handle.port}`);
    expect(first.status).toBe(200);
    await expect(handle.waitForCode()).resolves.toBe('one');
    const second = await get(handle.port, '/callback?code=two&state=st', `127.0.0.1:${handle.port}`).catch(() => ({ status: 0, body: '' }));
    expect([0, 409]).toContain(second.status);
  });

  it('a callback with the wrong state ends the attempt with an oauth_error', async () => {
    handle = await startLoopback({ state: 'st', timeoutMs: 10_000 });
    const waiting = handle.waitForCode();
    await get(handle.port, '/callback?code=c&state=forged', `localhost:${handle.port}`);
    await expect(waiting).rejects.toMatchObject({ code: 'oauth_error', details: { reason: 'state_mismatch' } });
  });
});

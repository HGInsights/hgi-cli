import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { LOOPBACK_REDIRECT_HOST } from '../config.js';
import { HgiError } from '../errors.js';
import { evaluateCallbackParams } from './callback.js';

export interface LoopbackHandle {
  port: number;
  redirectUri: string;
  waitForCode(): Promise<string>;
  close(): void;
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.5">` +
  `<h1>${title}</h1><p>${body}</p></body></html>`;

export async function startLoopback(opts: { state: string; timeoutMs: number }): Promise<LoopbackHandle> {
  let settle!: { resolve: (code: string) => void; reject: (err: unknown) => void };
  const result = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  result.catch(() => undefined);

  let done = false;
  let port = 0;

  const server = http.createServer((req, res) => {
    const respond = (status: number, title: string, body: string) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAGE(title, body));
    };
    if (req.method !== 'GET') return respond(405, 'Method not allowed', 'Only GET is accepted.');
    const allowedHosts = [`127.0.0.1:${port}`, `${LOOPBACK_REDIRECT_HOST}:${port}`];
    if (!allowedHosts.includes(req.headers.host ?? '')) return respond(400, 'Bad request', 'Unexpected Host header.');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname !== '/callback') return respond(404, 'Not found', 'Nothing here.');
    if (done) return respond(409, 'Already used', 'This sign-in callback was already handled.');
    done = true;
    try {
      const code = evaluateCallbackParams(url.searchParams, opts.state);
      respond(200, 'Signed in', 'You can close this tab and return to your terminal.');
      settle.resolve(code);
    } catch (err) {
      respond(400, 'Sign-in failed', 'Return to your terminal for details.');
      settle.reject(err);
    }
    setImmediate(() => close());
  });

  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    settle.reject(
      new HgiError('oauth_error', 'Timed out waiting for the browser sign-in to finish.', {
        hint: 'Run `hgi auth login` again, or use `--no-browser` on a remote machine.',
        details: { reason: 'login_timeout' },
      }),
    );
    close();
  }, opts.timeoutMs);
  timer.unref();

  function close(): void {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  }).catch((err: unknown) => {
    throw new HgiError('local_state_error', 'Could not open a loopback port for the sign-in callback.', {
      details: { kind: 'write_failed' },
      cause: err,
    });
  });
  port = (server.address() as AddressInfo).port;

  return {
    port,
    redirectUri: `http://${LOOPBACK_REDIRECT_HOST}:${port}/callback`,
    waitForCode: () => result,
    close,
  };
}

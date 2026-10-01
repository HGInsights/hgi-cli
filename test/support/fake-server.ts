import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface Fault {
  match: { path?: string; rpcMethod?: string };
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  rpcError?: { code: number; message: string };
  destroy?: boolean;
  truncate?: boolean;
  times?: number;
}

interface TokenRow {
  access: string;
  refresh: string;
  accessExpiresAt: number;
  revoked: boolean;
  userId: string;
}

export interface LoggedRequest {
  method: string;
  path: string;
  rpcMethod?: string;
  authorization?: string;
  userAgent?: string;
  body?: string;
}

const USER = { id: 'user-1', name: 'Test User', email: 'test@example.com' };
const ORG = { slug: 'madkudu', name: 'MadKudu' };

export class FakeServer {
  base = '';
  tools: FakeTool[] = [];
  /** When set, `initialize` answers with this protocol version instead of echoing the client's. */
  forcedProtocolVersion: string | null = null;
  handlers = new Map<string, (args: Record<string, unknown>) => ToolResult>();
  faults: Fault[] = [];
  requests: LoggedRequest[] = [];
  accessTtlSec = 3600;
  userinfoStatus: number | null = null;
  mcpVersion = 'v2';
  issuerOverride: string | null = null;
  redirectTokenPost = false;
  echoVerifierOnCodeExchange = false;
  onRefresh: (() => void) | null = null;
  lastVerifier = '';
  rows: TokenRow[] = [];
  refreshCalls = 0;
  private codes = new Map<string, { redirectUri: string; challenge: string; used: boolean }>();
  private server!: http.Server;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const port = (this.server.address() as AddressInfo).port;
    this.base = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  seedSession(ttlSec = 3600): { access: string; refresh: string } {
    const prev = this.accessTtlSec;
    this.accessTtlSec = ttlSec;
    const row = this.issue(USER.id);
    this.accessTtlSec = prev;
    return { access: row.access, refresh: row.refresh };
  }

  reset(): void {
    this.requests = [];
    this.faults = [];
    this.rows = [];
    this.codes.clear();
    this.refreshCalls = 0;
    this.forcedProtocolVersion = null;
  }

  toolCalls(): LoggedRequest[] {
    return this.requests.filter((r) => r.rpcMethod === 'tools/call');
  }

  private json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'content-type': 'application/json', 'x-mcp-version': this.mcpVersion, ...headers });
    res.end(JSON.stringify(body));
  }

  private takeFault(path: string, rpcMethod?: string): Fault | undefined {
    const idx = this.faults.findIndex(
      (f) => (!f.match.path || f.match.path === path) && (!f.match.rpcMethod || f.match.rpcMethod === rpcMethod),
    );
    if (idx < 0) return undefined;
    const fault = this.faults[idx] as Fault;
    if (fault.times !== undefined) {
      fault.times -= 1;
      if (fault.times <= 0) this.faults.splice(idx, 1);
    }
    return fault;
  }

  private async readBody(req: http.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c as Buffer));
    return Buffer.concat(chunks).toString('utf8');
  }

  private bearer(req: http.IncomingMessage): TokenRow | null {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return null;
    const token = header.slice(7);
    const row = this.rows.find((r) => r.access === token);
    if (!row || row.revoked || row.accessExpiresAt <= Date.now()) return null;
    return row;
  }

  private issue(userId: string): TokenRow {
    const row: TokenRow = {
      access: `at_${randomBytes(18).toString('hex')}`,
      refresh: `rt_${randomBytes(18).toString('hex')}`,
      accessExpiresAt: Date.now() + this.accessTtlSec * 1000,
      revoked: false,
      userId,
    };
    this.rows.push(row);
    return row;
  }

  private tokenResponse(row: TokenRow): Record<string, unknown> {
    return {
      access_token: row.access,
      token_type: 'Bearer',
      expires_in: this.accessTtlSec,
      refresh_token: row.refresh,
      scope: 'mcp:read mcp:tools offline_access',
    };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.base);
    const body = req.method === 'POST' ? await this.readBody(req) : '';
    let rpcMethod: string | undefined;
    if (url.pathname === '/api/ai/mcp' && body) {
      try {
        rpcMethod = (JSON.parse(body) as { method?: string }).method;
      } catch {
        rpcMethod = undefined;
      }
    }
    this.requests.push({
      method: req.method ?? 'GET',
      path: url.pathname,
      rpcMethod,
      authorization: req.headers.authorization,
      userAgent: req.headers['user-agent'],
      body,
    });

    const fault = this.takeFault(url.pathname, rpcMethod);
    if (fault) {
      if (fault.destroy) {
        req.socket.destroy();
        return;
      }
      if (fault.truncate) {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '5000' });
        res.write('{"jsonrpc":"2.0","id":3,"res');
        setTimeout(() => req.socket.destroy(), 30);
        return;
      }
      if (fault.rpcError) {
        const id = (JSON.parse(body) as { id?: number }).id ?? null;
        this.json(res, 200, { jsonrpc: '2.0', id, error: fault.rpcError });
        return;
      }
      this.json(res, fault.status, fault.body ?? { error: 'fault' }, fault.headers);
      return;
    }

    switch (url.pathname) {
      case '/.well-known/oauth-authorization-server':
        return this.json(res, 200, {
          issuer: this.issuerOverride ?? this.base,
          authorization_endpoint: `${this.base}/oauth/authorize`,
          token_endpoint: `${this.base}/oauth/token`,
          revocation_endpoint: `${this.base}/oauth/revoke`,
          userinfo_endpoint: `${this.base}/oauth/userinfo`,
        });
      case '/oauth/authorize':
        return this.authorize(url, res);
      case '/oauth/token':
        return this.token(body, res);
      case '/oauth/revoke':
        return this.revoke(body, res);
      case '/oauth/userinfo':
        return this.userinfo(req, res);
      case '/api/ai/mcp':
        return this.mcp(req, res, body, rpcMethod);
      default:
        return this.json(res, 404, { error: 'not_found' });
    }
  }

  private authorize(url: URL, res: http.ServerResponse): void {
    const redirectUri = url.searchParams.get('redirect_uri') ?? '';
    const state = url.searchParams.get('state') ?? '';
    const challenge = url.searchParams.get('code_challenge') ?? '';
    const code = `code_${randomBytes(12).toString('hex')}`;
    this.codes.set(code, { redirectUri, challenge, used: false });
    res.writeHead(302, { location: `${redirectUri}?code=${code}&state=${encodeURIComponent(state)}` });
    res.end();
  }

  private token(raw: string, res: http.ServerResponse): void {
    if (this.redirectTokenPost) {
      res.writeHead(307, { location: 'https://evil.example/oauth/token' });
      res.end();
      return;
    }
    const params = new URLSearchParams(raw);
    const grant = params.get('grant_type');
    const err = (status: number, error: string, description?: string) =>
      this.json(res, status, { error, error_description: description ?? error });
    if (grant === 'authorization_code') {
      const code = params.get('code') ?? '';
      const entry = this.codes.get(code);
      if (!entry || entry.used) return err(400, 'invalid_grant', 'code is invalid or already used');
      entry.used = true;
      if (params.get('redirect_uri') !== entry.redirectUri) return err(400, 'invalid_grant', 'redirect_uri mismatch');
      const verifier = params.get('code_verifier') ?? '';
      this.lastVerifier = verifier;
      if (this.echoVerifierOnCodeExchange) return err(400, 'invalid_request', `could not verify ${verifier} for this client`);
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (challenge !== entry.challenge) return err(400, 'invalid_grant', 'PKCE failed');
      return this.json(res, 200, this.tokenResponse(this.issue(USER.id)));
    }
    if (grant === 'refresh_token') {
      this.refreshCalls += 1;
      this.onRefresh?.();
      const refresh = params.get('refresh_token') ?? '';
      const row = this.rows.find((r) => r.refresh === refresh && !r.revoked);
      if (!row) return err(400, 'invalid_grant', 'refresh token is invalid, expired or revoked');
      row.revoked = true;
      return this.json(res, 200, this.tokenResponse(this.issue(row.userId)));
    }
    return err(400, 'unsupported_grant_type');
  }

  private revoke(raw: string, res: http.ServerResponse): void {
    const token = new URLSearchParams(raw).get('token') ?? '';
    const row = this.rows.find((r) => r.access === token || r.refresh === token);
    if (row) row.revoked = true;
    res.writeHead(200);
    res.end();
  }

  private userinfo(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (this.userinfoStatus) return this.json(res, this.userinfoStatus, { error: 'temporarily_unavailable' }, { 'retry-after': '1' });
    const row = this.bearer(req);
    if (!row) return this.json(res, 401, { error: 'invalid_token' });
    this.json(res, 200, { user: USER, organization: ORG, client: { id: `${this.base}/.well-known/oauth-clients/hgi-cli.json`, name: 'HG Insights CLI' } });
  }

  private mcp(req: http.IncomingMessage, res: http.ServerResponse, raw: string, rpcMethod?: string): void {
    if (req.method === 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }
    if (req.method === 'DELETE') {
      res.writeHead(200);
      res.end();
      return;
    }
    if (!this.bearer(req)) {
      return this.json(res, 401, { jsonrpc: '2.0', error: { code: -32603, message: 'Unauthorized' }, id: null }, { 'www-authenticate': 'Bearer' });
    }
    const message = JSON.parse(raw) as { id?: number | string; method: string; params?: Record<string, unknown> };
    if (message.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    const reply = (result: unknown) => this.json(res, 200, { jsonrpc: '2.0', id: message.id, result });
    switch (rpcMethod) {
      case 'initialize':
        return reply({
          protocolVersion: this.forcedProtocolVersion ?? (message.params?.protocolVersion as string) ?? '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-phoenix', version: '1.0.0' },
        });
      case 'tools/list':
        return reply({ tools: this.tools });
      case 'tools/call': {
        const name = message.params?.name as string;
        const handler = this.handlers.get(name);
        if (!handler) {
          return this.json(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `Tool ${name} not found` } });
        }
        return reply(handler((message.params?.arguments as Record<string, unknown>) ?? {}));
      }
      default:
        return this.json(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
    }
  }
}

export const READ_TOOL: FakeTool = {
  name: 'company_lookup',
  description: 'Look up a company by domain.',
  inputSchema: {
    type: 'object',
    properties: { domain: { type: 'string' }, limit: { type: 'integer' } },
    required: ['domain'],
  },
  annotations: { readOnlyHint: true },
};

export const WRITE_TOOL: FakeTool = {
  name: 'start_agent',
  description: 'Start an agent run.',
  inputSchema: { type: 'object', properties: { agent: { type: 'string' } }, required: ['agent'] },
  annotations: { readOnlyHint: false },
};

export const UNANNOTATED_TOOL: FakeTool = {
  name: 'aggregated_thing',
  description: 'No annotations at all.',
  inputSchema: { type: 'object', properties: {} },
};

export function textResult(value: unknown, cost: number | null = 1): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(cost === null ? {} : { _meta: { creditCost: cost } }),
  };
}

export async function closedPort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

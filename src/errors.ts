import { escapeJsonForTerminal, sanitizeForTerminal } from './output/sanitize.js';
import { redact, redactDeep } from './redact.js';

export const EXIT = {
  OK: 0,
  INTERNAL: 1,
  INVALID_INPUT: 2,
  TOOL_ERROR: 3,
  LOGIN: 4,
  RATE_LIMITED: 5,
  CREDIT: 6,
  UNREACHABLE: 7,
  OAUTH: 8,
  NETWORK: 9,
  WRONG_VERB: 10,
  FORBIDDEN: 11,
  LOCAL_STATE: 12,
} as const;

export type ErrorCode =
  | 'internal_error'
  | 'invalid_input'
  | 'tool_error'
  | 'login_required'
  | 'login_expired'
  | 'rate_limited'
  | 'credit_limit_exceeded'
  | 'server_unreachable'
  | 'oauth_error'
  | 'network_proxy_tls'
  | 'wrong_verb'
  | 'forbidden'
  | 'local_state_error';

export const ERROR_EXIT: Record<ErrorCode, number> = {
  internal_error: EXIT.INTERNAL,
  invalid_input: EXIT.INVALID_INPUT,
  tool_error: EXIT.TOOL_ERROR,
  login_required: EXIT.LOGIN,
  login_expired: EXIT.LOGIN,
  rate_limited: EXIT.RATE_LIMITED,
  credit_limit_exceeded: EXIT.CREDIT,
  server_unreachable: EXIT.UNREACHABLE,
  oauth_error: EXIT.OAUTH,
  network_proxy_tls: EXIT.NETWORK,
  wrong_verb: EXIT.WRONG_VERB,
  forbidden: EXIT.FORBIDDEN,
  local_state_error: EXIT.LOCAL_STATE,
};

export const LOGIN_HINT = 'Run `hgi auth login` to sign in again.';

export interface HgiErrorInit {
  hint?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class HgiError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, init: HgiErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'HgiError';
    this.code = code;
    this.hint = init.hint;
    this.details = init.details;
  }

  get exitCode(): number {
    return ERROR_EXIT[this.code];
  }
}

export interface ErrorBody {
  schema: 1;
  error: {
    code: ErrorCode;
    exit_code: number;
    message: string;
    hint?: string;
    details?: Record<string, unknown>;
  };
}

export function toErrorBody(err: HgiError): ErrorBody {
  const body: ErrorBody = {
    schema: 1,
    error: {
      code: err.code,
      exit_code: err.exitCode,
      message: err.message,
    },
  };
  if (err.hint) body.error.hint = err.hint;
  if (err.details && Object.keys(err.details).length > 0) body.error.details = err.details;
  return redactDeep(body);
}

export function renderError(err: HgiError, asJson: boolean): string {
  const body = toErrorBody(err);
  if (asJson) return `${escapeJsonForTerminal(JSON.stringify(body))}\n`;
  const lines = [`hgi: ${body.error.message}`];
  if (body.error.hint) lines.push(`  ${body.error.hint}`);
  return `${sanitizeForTerminal(redact(lines.join('\n')))}\n`;
}

export function toHgiError(err: unknown): HgiError {
  if (err instanceof HgiError) return err;
  const net = classifyNetworkError(err);
  if (net) return net;
  const message = err instanceof Error ? err.message : String(err);
  return new HgiError('internal_error', `Unexpected error: ${message}`, {
    hint: 'This is a bug in hgi. Re-run with --debug and report it.',
    cause: err,
  });
}

const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'CERT_REVOKED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'EPROTO',
]);

const PROXY_CODES = new Set([
  'UND_ERR_PRX_TLS',
  'ERR_PROXY_CONNECT',
  'UND_ERR_PROXY_INFO',
]);

const UNREACHABLE_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_ABORTED',
]);

function causeChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur; i += 1) {
    chain.push(cur);
    cur = (cur as { cause?: unknown }).cause;
  }
  return chain;
}

export function networkErrorCode(err: unknown): string | undefined {
  for (const link of causeChain(err)) {
    const code = (link as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

export function classifyNetworkError(err: unknown, context = 'the server', viaProxy?: string): HgiError | null {
  const code = networkErrorCode(err);
  const chainText = causeChain(err)
    .map((l) => (l instanceof Error ? l.message : ''))
    .join(' ');
  const proxyMentioned = /proxy/i.test(chainText);

  if (code && PROXY_CODES.has(code)) {
    return new HgiError('network_proxy_tls', `Proxy problem reaching ${context} (${code}).`, {
      hint: 'Check HTTPS_PROXY / HTTP_PROXY / NO_PROXY and your proxy credentials.',
      details: { cause: code },
      cause: err,
    });
  }
  if (code && TLS_CODES.has(code)) {
    return new HgiError('network_proxy_tls', `TLS verification failed for ${context} (${code}).`, {
      hint: 'If a corporate proxy re-signs traffic, point NODE_EXTRA_CA_CERTS at its CA bundle.',
      details: { cause: code },
      cause: err,
    });
  }
  if (viaProxy && code && UNREACHABLE_CODES.has(code)) {
    return new HgiError('network_proxy_tls', `Could not connect through the proxy ${viaProxy} (${code}).`, {
      hint: 'Check HTTPS_PROXY / HTTP_PROXY / NO_PROXY, that the proxy is reachable, and your proxy credentials.',
      details: { cause: code, proxy: viaProxy },
      cause: err,
    });
  }
  if (proxyMentioned) {
    return new HgiError('network_proxy_tls', `Proxy problem reaching ${context}.`, {
      hint: 'Check HTTPS_PROXY / HTTP_PROXY / NO_PROXY and your proxy credentials.',
      details: code ? { cause: code } : undefined,
      cause: err,
    });
  }
  if (code && UNREACHABLE_CODES.has(code)) {
    return new HgiError('server_unreachable', `Could not reach ${context} (${code}).`, {
      hint: 'Check your network connection and HGI_BASE_URL, then retry.',
      details: { cause: code },
      cause: err,
    });
  }
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return new HgiError('server_unreachable', `Timed out talking to ${context}.`, {
      hint: 'Retry, or raise --timeout.',
      details: { cause: err.name },
      cause: err,
    });
  }
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) {
    return new HgiError('server_unreachable', `Could not reach ${context}.`, {
      hint: 'Check your network connection and HGI_BASE_URL, then retry.',
      cause: err,
    });
  }
  return null;
}

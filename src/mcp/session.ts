import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolResultSchema,
  ErrorCode,
  ListToolsResultSchema,
  McpError,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { CommandContext } from '../commands/context.js';
import { mcpUrl, VERSION } from '../config.js';
import { debug } from '../debug.js';
import { HgiError, toHgiError } from '../errors.js';
import { createTransportFetch, type TransportState } from './transport-fetch.js';
import type { McpTool } from './tools.js';

export interface McpSession {
  state: TransportState;
  serverInfo: { name?: string; version?: string } | null;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

const POST_DISPATCH_UNCERTAIN = new Set(['server_unreachable', 'network_proxy_tls', 'internal_error']);

function markOutcomeUnknown(err: HgiError, state: TransportState): HgiError {
  if (!state.toolsCallWritten || !POST_DISPATCH_UNCERTAIN.has(err.code) || err.details?.outcome_unknown !== undefined) {
    return err;
  }
  return new HgiError(err.code, err.message, {
    hint: 'The call may or may not have run and may have been billed. Check state before re-running; do not just retry.',
    details: { ...err.details, outcome_unknown: true },
    cause: err.cause,
  });
}

export function mapMcpError(err: unknown, state: TransportState): HgiError {
  return markOutcomeUnknown(mapMcpErrorInner(err, state), state);
}

function mapMcpErrorInner(err: unknown, state: TransportState): HgiError {
  if (err instanceof HgiError) return err;
  const outcomeUnknown = state.toolsCallWritten ? { outcome_unknown: true } : {};
  if (err instanceof McpError) {
    if (err.code === ErrorCode.RequestTimeout || err.code === ErrorCode.ConnectionClosed) {
      return new HgiError('server_unreachable', `The connection to the server failed (${err.message}).`, {
        hint: state.toolsCallWritten
          ? 'The call may or may not have run. Check state before re-running.'
          : 'Check your network and retry, or raise --timeout.',
        details: { jsonrpc_code: err.code, ...outcomeUnknown },
        cause: err,
      });
    }
    return new HgiError('tool_error', `The server returned an error: ${err.message}`, {
      details: { jsonrpc_code: err.code },
      cause: err,
    });
  }
  const unsupported = /Server's protocol version is not supported: (\S+)/.exec(err instanceof Error ? err.message : '');
  if (unsupported) {
    return new HgiError('server_unreachable', `The server chose MCP protocol version ${unsupported[1]}, which this hgi does not support.`, {
      hint: 'Upgrade hgi (see docs/compatibility.md for the versions this release speaks).',
      details: { reason: 'unsupported_protocol_version', server_protocol_version: unsupported[1] },
      cause: err,
    });
  }
  const name = (err as { name?: string } | null)?.name;
  const httpStatus = (err as { code?: unknown } | null)?.code;
  if (name === 'StreamableHTTPError' && typeof httpStatus === 'number') {
    if (httpStatus === 403) {
      return new HgiError('forbidden', 'The server refused this request (HTTP 403).', { details: { status: 403 }, cause: err });
    }
    return new HgiError('server_unreachable', `The MCP endpoint returned HTTP ${httpStatus}.`, {
      details: { status: httpStatus, ...outcomeUnknown },
      cause: err,
    });
  }
  if (state.toolsCallWritten && name !== 'TypeError') {
    return new HgiError('tool_error', 'The tool ran but its response could not be parsed.', {
      hint: 'The call may have been billed. Check state before re-running.',
      details: { unparseable: true },
      cause: err,
    });
  }
  return toHgiError(err);
}

export async function openSession(ctx: CommandContext, opts: { timeoutMs: number }): Promise<McpSession> {
  const state: TransportState = { mcpVersion: null, toolsCallWritten: false };
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl(ctx.base)), {
    fetch: createTransportFetch(ctx.authedFetch, state, { timeoutMs: opts.timeoutMs }) as never,
  });
  const client = new Client({ name: 'hgi', version: VERSION }, { capabilities: {} });

  try {
    await client.connect(transport);
  } catch (err) {
    await transport.close().catch(() => undefined);
    throw mapMcpError(err, state);
  }
  const info = client.getServerVersion();
  const requestOptions = { timeout: opts.timeoutMs };

  return {
    state,
    serverInfo: info ? { name: info.name, version: info.version } : null,
    async listTools() {
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      try {
        do {
          const page = await client.request(
            { method: 'tools/list', params: cursor ? { cursor } : {} },
            ListToolsResultSchema,
            requestOptions,
          );
          tools.push(...(page.tools as unknown as McpTool[]));
          cursor = page.nextCursor;
        } while (cursor);
      } catch (err) {
        throw mapMcpError(err, state);
      }
      return tools;
    },
    async callTool(name, args) {
      try {
        return await client.request(
          { method: 'tools/call', params: { name, arguments: args } },
          CallToolResultSchema,
          requestOptions,
        );
      } catch (err) {
        throw mapMcpError(err, state);
      }
    },
    async close() {
      try {
        await client.close();
      } catch (err) {
        debug('session close failed', err);
      }
    },
  };
}

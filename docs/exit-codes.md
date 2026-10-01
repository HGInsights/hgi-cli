# Exit codes and error format

Every failure has its own exit code, so a script can branch without parsing English.

| Exit | `error.code` | When |
|---|---|---|
| 0 | | success |
| 1 | `internal_error` | a bug in `hgi`. Never used for a server response or a usage error |
| 2 | `invalid_input` | bad flags or usage; invalid JSON; input that fails the tool's schema; unknown tool; unreadable `--input @file`; `--out` refusals (exists, symlink, protected path, `--force` on `call`); config-dir workspace guard |
| 3 | `tool_error` | the tool returned `isError` (including server-side invalid arguments, which the server reports in-band), a JSON-RPC error, or a response `hgi` could not parse after the call was sent |
| 4 | `login_required`, `login_expired` | no credentials; a second 401 after one refresh; the refresh token was rejected (`invalid_grant`) |
| 5 | `rate_limited` | 429 after bounded retries (MCP calls); a 429 from the userinfo or revoke endpoint exits at once |
| 6 | `credit_limit_exceeded` | `_meta.errorCode === "credit_limit_exceeded"` on a tool result |
| 7 | `server_unreachable` | DNS failure, refused connection, timeout, HTTP 5xx, an unexpected redirect from the MCP endpoint, the server shedding load after retries, or the server choosing an MCP protocol version this `hgi` does not speak (`details.reason` is `unsupported_protocol_version`; upgrade `hgi`) |
| 8 | `oauth_error` | discovery or issuer mismatch, state or redirect mismatch, consent denied, a rejected or reused sign-in code, a token-endpoint failure, an unexpected redirect on an auth request |
| 9 | `network_proxy_tls` | TLS verification failure or proxy failure; the message names the cause (for example `DEPTH_ZERO_SELF_SIGNED_CERT`) |
| 10 | `wrong_verb` | `hgi call` on a state-changing tool, or `hgi run` on a read-only one. Nothing is sent |
| 11 | `forbidden` | HTTP 403 |
| 12 | `local_state_error` | corrupt or unsafe-mode credentials file (`details.kind` is `credentials_corrupt` or `credentials_unsafe`), lock timeout, or a failed local write. If `details.tool_ran` is `true` (an `--out` write failed *after* the tool ran), the tool already ran and was billed, its result was printed to stdout instead, and you must **not** re-run it |

`hgi --help` and `hgi --version` exit 0.

## The error body

When stderr is not a terminal (or you pass `--json-errors`), errors are one JSON object on stderr and nothing on stdout (the one exception: exit 12 with `details.tool_ran: true`, where the tool already ran and its result is printed on stdout):

```json
{"schema":1,"error":{"code":"credit_limit_exceeded","exit_code":6,"message":"...","hint":"...","details":{"tool":"company_enrich"}}}
```

- `schema` is the version of this format. New fields may be added; existing ones keep their meaning.
- `code` and `exit_code` are stable. `message` and `hint` are for humans.
- `details` carries machine-readable context where it exists:
  - `retry_after_seconds` on `rate_limited`
  - `outcome_unknown` on `tools/call` failures (see below)
  - `expected_verb` on `wrong_verb`
  - `reason` on `invalid_input` and `oauth_error` (for example `unknown_tool`, `schema`, `state_mismatch`)
  - `cause` on `server_unreachable` and `network_proxy_tls` (a Node error code)
  - `location_host` on an unexpected redirect

On a terminal, errors are plain text with a hint.

## `outcome_unknown`

`hgi` retries only failures that happen **before the server runs the tool**: a 401 (after a refresh), a 429, the server's 503 "shedding load" response, and a refused or unresolvable connection. If a connection drops, times out, a proxy resets it, or a 5xx arrives **after** a `tools/call` was sent, it is not retried, because `hgi run` could start the work twice. The error then has `"outcome_unknown": true` and a hint to check state first. This marker is added to every network-class or unclassified failure once the call was sent, so it can appear with exit 1, 7 or 9. An exhausted load-shed retry has `"outcome_unknown": false`: nothing ran and retrying is safe.

## Credit cost

Success prints the tool result on stdout and the credit cost on stderr (`credit_cost: 3`, or `{"credit_cost":3}` when stderr is not a terminal). Tools that do not report a cost (external, aggregated tools) show `unknown` / `null`, never `0`.

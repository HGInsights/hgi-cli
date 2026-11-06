# Exit codes and error format

Every failure has its own exit code, so a script can branch without parsing English.

| Exit | `error.code` | When |
|---|---|---|
| 0 | | success |
| 1 | `internal_error` | a bug in `hgi`. Never used for a server response or a usage error |
| 2 | `invalid_input` | bad flags or usage; invalid JSON; input that fails the tool's schema; unknown tool; unreadable `--input @file`; `--out` refusals (exists, symlink, protected path, `--force` on `call`); config-dir workspace guard |
| 3 | `tool_error` | the tool returned `isError` (including server-side invalid arguments, which the server reports in-band), a JSON-RPC error, or a response `hgi` could not parse after the call was sent |
| 4 | `login_required`, `login_expired`, `phoenix_account_required` | no credentials; a second 401 after one refresh; the refresh token was rejected (`invalid_grant`). `phoenix_account_required`: the server says the signed-in identity has no Phoenix account; sign up, or sign in with `hgi auth login` as an account that has one |
| 5 | `rate_limited` | 429 after bounded retries (MCP calls); a 429 from the userinfo or revoke endpoint exits at once |
| 6 | `credit_limit_exceeded`, `user_credit_limit_exceeded` | the server refused the call: your organization's credit allowance (`credit_limit_exceeded`) or your personal credit budget (`user_credit_limit_exceeded`) is used up. Retrying will not help; ask an admin, or wait for the next billing period |
| 7 | `server_unreachable`, `governance_unavailable` | `governance_unavailable`: the server could not check your budget, so nothing ran (`details.retryable: true`, `details.outcome_unknown: false`); retry shortly. `hgi` never retries it itself. `server_unreachable`: DNS failure, refused connection, timeout, HTTP 5xx, an unexpected redirect from the MCP endpoint, the server shedding load after retries, or the server choosing an MCP protocol version this `hgi` does not speak (`details.reason` is `unsupported_protocol_version`; upgrade `hgi`) |
| 8 | `oauth_error` | discovery or issuer mismatch, state or redirect mismatch, consent denied, a rejected or reused sign-in code, a token-endpoint failure, an unexpected redirect on an auth request |
| 9 | `network_proxy_tls` | TLS verification failure or proxy failure; the message names the cause (for example `DEPTH_ZERO_SELF_SIGNED_CERT`) |
| 10 | `wrong_verb` | `hgi call` on a state-changing tool, or `hgi run` on a read-only one. Nothing is sent |
| 11 | `forbidden`, `tool_not_enabled_for_team` | HTTP 403; or the server says this tool is not enabled for your team (ask an admin) |
| 12 | `local_state_error` | corrupt or unsafe-mode credentials file (`details.kind` is `credentials_corrupt` or `credentials_unsafe`), lock timeout, or a failed local write. If `details.tool_ran` is `true` (an `--out` write failed *after* the tool ran), the tool already ran and was billed, its result was printed to stdout instead, and you must **not** re-run it. Budget files ([Run cap](#run-cap)): `budget_corrupt` (a budget file, or its directory, is unreadable, malformed or unsafe; nothing was sent) and `budget_write_failed` (the spend could not be recorded; after a successful call, `details.tool_ran` is `true` and the result is on stdout, even with `--out`) |
| 13 | `budget_exceeded` | `hgi call` with a run cap (`--max-credits`, `HGI_MAX_CREDITS`) when the run has already spent its cap. Nothing was sent. `details`: `spent`, `max`, `budget_id`. Raise the cap or run `hgi budget reset` |

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
  - `tool` and `server_error_code` on every error from a tool result (`server_error_code` is the server's raw `_meta.errorCode`, when it sent one; an unknown one stays `tool_error`)
  - `retryable` on `governance_unavailable`: nothing ran, and retrying later is safe
  - `budget_write_failed: true` on a server refusal (exit 3, 4, 6, 7 or 11) whose spend could not be recorded under a run cap; the refusal is still the error to act on
  - `spent`, `max` and `budget_id` on `budget_exceeded`
  - `kind` on `local_state_error`: `credentials_corrupt`, `credentials_unsafe`, `lock_timeout`, `lock_compromised`, `write_failed`, `budget_corrupt` or `budget_write_failed`; with `tool_ran` when the tool already ran

On a terminal, errors are plain text with a hint.

## `outcome_unknown`

`hgi` retries only failures that happen **before the server runs the tool**: a 401 (after a refresh), a 429, the server's 503 "shedding load" response, and a refused or unresolvable connection. If a connection drops, times out, a proxy resets it, or a 5xx arrives **after** a `tools/call` was sent, it is not retried, because `hgi run` could start the work twice. The error then has `"outcome_unknown": true` and a hint to check state first. This marker is added to every network-class or unclassified failure once the call was sent, so it can appear with exit 1, 7 or 9. An exhausted load-shed retry has `"outcome_unknown": false`: nothing ran and retrying is safe.

## Credit cost

Success prints the tool result on stdout and the credit cost on stderr (`credit_cost: 3`, or `{"credit_cost":3}` when stderr is not a terminal). Tools that do not report a cost (external, aggregated tools) show `unknown` / `null`, never `0`.

## Run cap

`hgi call --max-credits <n>` (or `HGI_MAX_CREDITS=<n>`; the flag wins) caps what one run may spend. A run is every `hgi call` that shares a budget id: `HGI_BUDGET_ID` when set, otherwise the parent process id, so every `hgi` started from one shell or script counts together. `<n>` is a whole number of credits; `0` refuses every call, which proves a run is free.

- The cap is **client-side only, on top of the server's limits**. The organization and personal limits still apply, and are enforced by the server.
- It covers `hgi call` only. `hgi run` has no `--max-credits`, ignores `HGI_MAX_CREDITS`, and is neither checked nor counted.
- Before each capped call, `hgi` refuses with exit 13 when the budget has already spent its cap, and sends nothing. After the call, it adds the cost the server reported (`_meta.creditCost`), for error results too. A tool that reports no cost counts as 0 and is counted in `unknown_cost_calls`.
- The server gives no price before a call, so a run can overshoot its cap by the calls running at the same time: one call when calls run one after another, more when they run in parallel.
- Spend is recorded only when a cap is set. It lives in `~/.config/hgi/budgets/` (see [security](security.md)); a file not updated for 7 days is deleted on the next budget write.
- `hgi budget status [--max-credits <n>]` prints `{budget_id, spent, max, remaining, calls, unknown_cost_calls}`; `hgi budget reset` starts the count over. Neither needs a sign-in or sends anything.

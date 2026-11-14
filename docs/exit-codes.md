# Exit codes and error format

Every failure has its own exit code, so a script can branch without parsing English.

| Exit | `error.code` | When |
|---|---|---|
| 0 | | success |
| 1 | `internal_error` | a bug in `hgi`. Never used for a server response or a usage error |
| 2 | `invalid_input` | bad flags or usage; invalid JSON; input that fails the tool's schema; unknown tool; unreadable `--input @file` or `--ids @file`; `--out` refusals (exists, symlink, protected path, `--force` on `call`); config-dir or `HGI_LEDGER` workspace guard (`workspace_guard`); a bad `--label` (`bad_label`), `hgi usage --since` (`bad_since`) or `--by` (`bad_by`); any `--ids` refusal (see [below](#partial-output-from---ids)). Nothing is sent |
| 3 | `tool_error` | the tool returned `isError` (including server-side invalid arguments, which the server reports in-band), a JSON-RPC error, or a response `hgi` could not parse after the call was sent. With `--ids`: at least one batch call failed (every row is printed first) |
| 4 | `login_required`, `login_expired`, `phoenix_account_required` | no credentials; a second 401 after one refresh; the refresh token was rejected (`invalid_grant`). `phoenix_account_required`: the server says the signed-in identity has no Phoenix account; sign up, or sign in with `hgi auth login` as an account that has one |
| 5 | `rate_limited` | 429 after bounded retries (MCP calls: 3 by default, `--retries` to change; see [Retries](#retries)), or a `Retry-After` longer than what is left of the retry budget; `details.attempts` says how many times the request was sent. A 429 from the userinfo or revoke endpoint exits at once |
| 6 | `credit_limit_exceeded`, `user_credit_limit_exceeded` | the server refused the call: your organization's credit allowance (`credit_limit_exceeded`) or your personal credit budget (`user_credit_limit_exceeded`) is used up. Retrying will not help; ask an admin, or wait for the next billing period |
| 7 | `server_unreachable`, `governance_unavailable` | `governance_unavailable`: the server could not check your budget, so nothing ran (`details.retryable: true`, `details.outcome_unknown: false`); retry shortly. `hgi call --retries <n>` re-sends it up to n times itself (then `details.attempts` is set); without `--retries`, and always on `hgi run`, it is not retried. `server_unreachable`: DNS failure, refused connection, timeout, HTTP 5xx, an unexpected redirect from the MCP endpoint, the server shedding load after retries (`details.attempts`), or the server choosing an MCP protocol version this `hgi` does not speak (`details.reason` is `unsupported_protocol_version`; upgrade `hgi`) |
| 8 | `oauth_error` | discovery or issuer mismatch, state or redirect mismatch, consent denied, a rejected or reused sign-in code, a token-endpoint failure, an unexpected redirect on an auth request |
| 9 | `network_proxy_tls` | TLS verification failure or proxy failure; the message names the cause (for example `DEPTH_ZERO_SELF_SIGNED_CERT`) |
| 10 | `wrong_verb` | `hgi call` on a state-changing tool, or `hgi run` on a read-only one. Nothing is sent |
| 11 | `forbidden`, `tool_not_enabled_for_team` | HTTP 403; or the server says this tool is not enabled for your team (ask an admin) |
| 12 | `local_state_error` | corrupt or unsafe-mode credentials file (`details.kind` is `credentials_corrupt` or `credentials_unsafe`), lock timeout, or a failed local write; `hgi usage` on a credit ledger that is a symlink or not a regular file (`details.kind: "ledger_unsafe"`) or cannot be read (`details.kind: "read_failed"`, `details.reason` is the error code). If `details.tool_ran` is `true` (an `--out` write failed *after* the tool ran), the tool already ran and was billed, its result was printed to stdout instead, and you must **not** re-run it. Budget files ([Run cap](#run-cap)): `budget_corrupt` (a budget file, or its directory, is unreadable, malformed or unsafe; nothing was sent) and `budget_write_failed` (the spend could not be recorded; after a successful call, `details.tool_ran` is `true` and the result is on stdout, even with `--out`) |
| 13 | `budget_exceeded` | `hgi call` with a run cap (`--max-credits`, `HGI_MAX_CREDITS`) when the run has already spent its cap. Nothing was sent. `details`: `spent`, `max`, `budget_id`. Raise the cap or run `hgi budget reset` |

`hgi --help` and `hgi --version` exit 0.

## The error body

When stderr is not a terminal (or you pass `--json-errors`), errors are one JSON object on stderr and nothing on stdout. There are two exceptions: exit 12 with `details.tool_ran: true`, where the tool already ran and its result is printed on stdout, and `hgi call --ids`, where the rows printed before the error stay on stdout ([below](#partial-output-from---ids)):

```json
{"schema":1,"error":{"code":"credit_limit_exceeded","exit_code":6,"message":"...","hint":"...","details":{"tool":"company_enrich"}}}
```

- `schema` is the version of this format. New fields may be added; existing ones keep their meaning.
- `code` and `exit_code` are stable. `message` and `hint` are for humans.
- `details` carries machine-readable context where it exists:
  - `retry_after_seconds` on `rate_limited`
  - `attempts` when retries ran out (`rate_limited`, an exhausted load-shed or refused connection, `governance_unavailable` on `hgi call --retries`): how many times the failing request was sent, 1 + its retries
  - `outcome_unknown` on `tools/call` failures (see below)
  - `expected_verb` on `wrong_verb`
  - `reason` on `invalid_input` and `oauth_error` (for example `unknown_tool`, `schema`, `state_mismatch`, `bad_retries`, `bad_retry_budget`)
  - `cause` on `server_unreachable` and `network_proxy_tls` (a Node error code)
  - `location_host` on an unexpected redirect
  - `tool` and `server_error_code` on every error from a tool result (`server_error_code` is the server's raw `_meta.errorCode`, when it sent one; an unknown one stays `tool_error`)
  - `retryable` on `governance_unavailable`: nothing ran, and retrying later is safe
  - `budget_write_failed: true` on a server refusal (exit 3, 4, 6, 7 or 11) whose spend could not be recorded under a run cap; the refusal is still the error to act on
  - `spent`, `max` and `budget_id` on `budget_exceeded`
  - `kind` on `local_state_error`: `credentials_corrupt`, `credentials_unsafe`, `lock_timeout`, `lock_compromised`, `write_failed`, `budget_corrupt`, `budget_write_failed`, `ledger_unsafe` or `read_failed`; with `tool_ran` when the tool already ran

On a terminal, errors are plain text with a hint.

## Partial output from `--ids`

`hgi call --ids` sends one call per batch, one at a time, and prints rows as batches return. How a run ends:

- **0**: every batch call succeeded, even if some rows are `not_found`.
- **3**: every row was printed, but at least one batch call failed (`isError`, a JSON-RPC error, an unparseable response, or a response with nothing to match against). Those rows carry the error; the run went on with the next batch. `details` has `failed_batches` (how many), `rows_emitted` and `calls_made`.
- **Any other code stops the run at once** (out of credits, sign-in expired, rate limited, unreachable, proxy/TLS, forbidden, a failure with `outcome_unknown: true`, and any later client-side stop): no further batch is sent and nothing is retried. The rows already printed stay on stdout (for `-f json|csv|yaml|table` and `--out`, the rows so far are written before the error). `details` adds `rows_emitted` (rows printed, in input order) and `calls_made` (`tools/call` requests attempted, including the one that failed), so you know where to resume. If `--out` cannot be written at that point, the rows go to stdout instead and `details.out_write_failed` is `true`; the exit code is still the original one.
- **12 with `details.tool_ran: true`**: every call ran, but `--out` could not be written at the end; the rows are on stdout. Do not re-run.

Exit 2 refusals specific to `--ids`, each before anything is sent (`details.reason`):

| `reason` | When |
|---|---|
| `no_ids` | no ids left after skipping blank lines and `#` comments (or empty CSV cells) |
| `bad_batch_size` | `--batch-size` is zero, not a whole number, or above the limit of a field the input uses (`details.field`, `details.max`) |
| `unknown_column` | `--ids-column` names a column the CSV header does not have (`details.columns`) |
| `bad_csv` | the `--ids-column` file has a quoted field that is never closed |
| `ids_column_without_ids`, `batch_size_without_ids` | `--ids-column` or `--batch-size` without `--ids` |
| `bad_ids_source` | `--ids` is not `@file` or `-` |
| `stdin_conflict` | `--ids -` together with `--input -` |
| `ids_conflict` | `--input` already has `hg_ids` or `domains` (`details.field`) |
| `unsupported_kind` | a line is a domain (or an HG id) and the tool's input schema has no `domains` (or `hg_ids`) array (`details.line`) |
| `unusable_max_items` | the tool declares a `maxItems` that is not a positive whole number, so it cannot be batched safely |
| `schema` | a batch fails the tool's input schema; `details.batch` says which. Every batch is checked before the first is sent |

## `outcome_unknown`

`hgi` retries only failures that happen **before the server runs the tool**: a 401 (after a refresh), a 429, the server's 503 "shedding load" response, and a refused or unresolvable connection. If a connection drops, times out, a proxy resets it, or a 5xx arrives **after** a `tools/call` was sent, it is not retried, because `hgi run` could start the work twice. The error then has `"outcome_unknown": true` and a hint to check state first. This marker is added to every network-class or unclassified failure once the call was sent, so it can appear with exit 1, 7 or 9. An exhausted load-shed retry has `"outcome_unknown": false`: nothing ran and retrying is safe.

A failure with `"outcome_unknown": true` is never retried, whatever `--retries` says. Neither is a TLS or proxy failure (exit 9: waiting does not fix it) or any exit 2, 3, 4, 6, 8, 10, 11, 12 or 13.

### Retries

What `hgi call` and `hgi run` retry, all before the tool runs:

| `code` in the retry line | What | Default limit | Wait |
|---|---|---|---|
| `rate_limited` | a 429 | 3, shared with `load_shed` | `Retry-After`, else 2, 4, 8 … s (at most 30) plus up to 1 s |
| `load_shed` | the server's 503 "shedding load" (503 + `Retry-After` + JSON-RPC `-32000`) | 3, shared with `rate_limited` | `Retry-After` |
| `not_established` | a connection that was refused or did not resolve before the request left; on requests other than `tools/call`, also other network failures and 502/503/504 | 2 | 0.5 s × attempt |
| `governance_unavailable` | the server could not check the budget (an in-band refusal raised before the tool runs) | not retried | full jitter: random in `[0, min(2^attempt, 30)]` s |

Each wait gets up to 0.25 s of extra jitter (not on `governance_unavailable`). Every wait is bounded by a **retry budget per request** (each `--ids` batch call is its own request): a wait longer than what is left of it ends the retries at once with the final error. The 401 → refresh → retry-once path is separate and is not counted.

- `--retries <n>` (or `HGI_RETRIES`; the flag wins), a whole number 0–20: each class above may retry up to n times, each on its own counter. `0` turns every retry off, built-in ones included. On `hgi call` it also re-sends `governance_unavailable` up to n times; `hgi run` never does (exit 7, `retryable: true`, and you decide).
- `--retry-budget <seconds>` (or `HGI_RETRY_BUDGET`; the flag wins), a positive number up to 3600: the per-request budget. Default 600 when retries are set, else 60. Without `--retries` it raises the budget and keeps the built-in counts.
- A bad value exits 2 `invalid_input` (`details.reason` `bad_retries` or `bad_retry_budget`) before credentials are read or anything is sent.
- `--timeout` bounds each attempt, not the waits between them.
- Each `governance_unavailable` attempt that came back is recorded like a single call: one credit-ledger row (`status: "tool_error"`) and, under a [run cap](#run-cap), its reported cost. The cap is checked again right before every re-send; when it is reached, the re-send is not sent and the command exits 13. Refused attempts are not billed, so `credit_cost` is the last attempt's.
- Every retry prints one line on stderr before its wait ([output formats](output-formats.md#retry-lines)).

`governance_unavailable` is the one in-band refusal `hgi` re-sends, because the server raises it before the tool runs (see `CONTRIBUTING.md` → Ground rules), and only on the read-only verb.

## Credit cost

Success prints the tool result on stdout and the credit cost on stderr (`credit_cost: 3`, or `{"credit_cost":3}` when stderr is not a terminal). Tools that do not report a cost (external, aggregated tools) show `unknown` / `null`, never `0`.

## Run cap

`hgi call --max-credits <n>` (or `HGI_MAX_CREDITS=<n>`; the flag wins) caps what one run may spend. A run is every `hgi call` that shares a budget id: `HGI_BUDGET_ID` when set, otherwise the parent process id, so every `hgi` started from one shell or script counts together. `<n>` is a whole number of credits; `0` refuses every call, which proves a run is free.

- The cap is **client-side only, on top of the server's limits**. The organization and personal limits still apply, and are enforced by the server.
- It covers `hgi call` only. `hgi run` has no `--max-credits`, ignores `HGI_MAX_CREDITS`, and is neither checked nor counted.
- Before each capped call, `hgi` refuses with exit 13 when the budget has already spent its cap, and sends nothing. After the call, it adds the cost the server reported (`_meta.creditCost`), for error results too. A tool that reports no cost counts as 0 and is counted in `unknown_cost_calls`.
- With `--ids`, every batch call is a capped call: checked before it is sent and counted after it. When the cap is reached partway, the run stops with exit 13 and the rows so far stay printed, with `rows_emitted` and `calls_made` as in [Partial output from `--ids`](#partial-output-from---ids). When a batch's spend cannot be recorded, its rows are printed first (to `--out` when given), then the run stops with exit 12 `budget_write_failed` and `details.tool_ran: true`.
- The server gives no price before a call, so a run can overshoot its cap by the calls running at the same time: one call when calls run one after another, more when they run in parallel.
- Spend is recorded only when a cap is set. It lives in `~/.config/hgi/budgets/` (see [security](security.md)); a file not updated for 7 days is deleted on the next budget write.
- `hgi budget status [--max-credits <n>]` prints `{budget_id, spent, max, remaining, calls, unknown_cost_calls}`; `hgi budget reset` starts the count over. Neither needs a sign-in or sends anything.

## Credit ledger

A credit ledger problem during `hgi call` or `hgi run` (the lock timed out, the ledger path is a symlink or not a regular file, the write failed) is a warning, never an exit code: the tool already ran and was billed, and a failure would invite a billed re-run. Stdout and the exit code are exactly what they would otherwise be, and stderr gets one line, `hgi: warning: credit ledger not updated: <reason>` on a terminal or `{"warning":"ledger_not_updated","reason":"<reason>"}` when stderr is JSON. The one exception is an `HGI_LEDGER` path inside a git working tree, refused with exit 2 (`workspace_guard`) before anything is sent.

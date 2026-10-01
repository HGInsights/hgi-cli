---
name: hgi
description: Look up company, contact, technology, intent and spend data from the HG Insights MCP server with the `hgi` command-line client. Use when the user asks about a company's tech stack, firmographics, intent signals, contacts, or wants to run an HG Insights agent, and `hgi` is installed.
---

# hgi: the HG Insights command-line client

`hgi` is a thin client for the HG Insights MCP server. It signs in once through the user's browser, then exposes every tool the server offers to the signed-in user.

## Rules

1. **List tools first.** Run `hgi tools list --json` before your first call in a session. The list depends on the user, their organization and the server version, so never assume a tool exists and never reuse a tool list from memory. Each tool is marked `call` or `run`, and `required` shows the mandatory input fields.
2. **Use `hgi call <tool> --input '<json>'` for lookups.** It only runs tools the server marks read-only. It is safe to run without asking.
3. **Use `hgi run <tool> --input '<json>'` only with the user's approval.** It runs tools that change state or start work (for example starting an agent run, uploading an artifact by URL, or starting a customer-data discovery). It also runs tools that do not declare themselves read-only. Ask the user, say what the tool will do, then run it.
4. **Report the credit cost after every call.** The cost is printed on stderr (`credit_cost: N`, or `{"credit_cost":N}` when stderr is not a terminal). `unknown` or `null` means the server did not report one. Tell the user what the call cost; credits are billed to their organization.
5. **Never read, print or copy the credentials file** under `~/.config/hgi/`, and do not put tokens in commands. If `hgi` says the login is missing or expired, ask the user to run `hgi auth login` themselves. It opens their browser.
6. **Using the wrong verb fails safely.** `hgi call` on a state-changing tool, or `hgi run` on a read-only tool, exits 10, names the right verb, and sends nothing.

## Recommended permissions (Claude Code)

Allow lookups, ask for everything that can change state. Put this in your user settings (`~/.claude/settings.json`) or a trusted project's `.claude/settings.json` (headless runs ignore the settings file of a directory that was never trusted):

```json
{
  "permissions": {
    "allow": ["Bash(hgi call *)", "Bash(hgi tools list *)", "Bash(hgi auth whoami)"],
    "ask": ["Bash(hgi run *)"]
  }
}
```

## Usage

```bash
hgi tools list --json                                   # what can I call?
hgi call company_enrich --input '{"domain":"acme.com"}' # lookup, JSON on stdout
hgi call search_companies --input '{"query":"saas"}' --select name,domain -f csv
hgi call <tool> --input '{"limit":100}' --out result.json        # big result to a new file
hgi run <tool> --input '{...}'                           # only after the user approves
```

- `--input` takes a JSON object. `@file.json` reads a file and `-` reads stdin.
- Output is JSON when piped and a table on a terminal. Use `-f json|jsonl|csv|yaml|table`.
- `--select a,b.c` keeps only those fields (dotted paths work through arrays). Prefer it, or `--out <new file>`, for large results; results are never truncated.
- `--meta` prints `{ "result": ..., "credit_cost": ..., "mcp_version": ... }` on stdout.

## Exit codes

**If an error from `hgi run` has `details.outcome_unknown: true`, whatever its exit code (1, 7 or 9), the work may already have started and been billed. Check state first; never just retry.**

| Code | Meaning | What to do |
|---|---|---|
| 0 | success | |
| 1 | internal error in hgi | report it; check state before re-running a `run` (see `outcome_unknown`) |
| 2 | invalid input or usage | fix the input; the JSON error lists the problem fields |
| 3 | the tool reported an error | read the message; do not blindly retry |
| 4 | not signed in, or login expired | ask the user to run `hgi auth login` |
| 5 | rate limited | wait `retry_after_seconds` from the error, then retry |
| 6 | out of credits | stop; tell the user. Retrying will not help |
| 7 | server unreachable | retry later. If `outcome_unknown` is `true`, check state before re-running a `run` |
| 8 | OAuth or sign-in failure | ask the user to run `hgi auth login` again |
| 9 | proxy or TLS problem | the error names the cause (see `NODE_EXTRA_CA_CERTS`, `HTTPS_PROXY`). After a `run`, check `outcome_unknown` before retrying |
| 10 | wrong verb | use the verb the error names |
| 11 | forbidden | the account or organization lacks access |
| 12 | local credential or file problem | follow the hint. If `details.tool_ran` is `true`, the tool already ran and its result is on stdout: do not re-run it |

Errors are JSON on stderr when it is not a terminal: `{"schema":1,"error":{"code","exit_code","message","hint","details"}}`.

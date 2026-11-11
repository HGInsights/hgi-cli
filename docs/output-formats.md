# Output formats

By default `hgi` prints **JSON when stdout is not a terminal** and a **table on a terminal**. Use `-f` to choose: `json`, `jsonl`, `csv`, `yaml`, `table`.

Results are never truncated. A large result prints complete in every format. Use `--out <file>` to write it to a new file instead of stdout.

## What "the result" is

`hgi call` / `hgi run` print the tool's result, picked in this order:

1. `structuredContent` if the tool returned it (this wins over any summary text block).
2. Otherwise, if there is exactly one text block, that text parsed as JSON. Text that is not JSON becomes `{"text": "<raw text>"}`.
3. Otherwise (several blocks, or non-text blocks): `{"content": [<blocks verbatim>]}`.

`--select` and every format below operate on that value.

## Rows

`jsonl`, `csv` and `table` need rows. The rows are:

- the value itself, if it is an array;
- otherwise the one top-level property that is an array of objects (for example `companies` in `{"total": 2, "companies": [...]}`), if there is exactly one;
- otherwise a single row (the whole value).

| Format | Output |
|---|---|
| `json` | the value; compact when piped, indented on a terminal |
| `jsonl` | one JSON object per row, one per line |
| `csv` | RFC 4180. Header is the ordered union of the rows' keys. Nested objects and arrays are written as JSON in the cell. `\r\n` line endings |
| `yaml` | the value as YAML |
| `table` | aligned columns, never truncated. A single object prints as a field/value table |

## `--select`

`--select a,b.c` keeps only those fields. Dotted paths go through arrays, so `--select total,companies.name,companies.hq.city` keeps `total` and, for every element of `companies`, only `name` and `hq.city`. Names that are absent are skipped. A shorter path wins over a longer one (`a` and `a.b` select all of `a`).

## `--meta`

`--meta` replaces the bare result on stdout with an envelope:

```json
{"result": {...}, "credit_cost": 2, "mcp_version": "v2"}
```

`--select` trims the `result` inside the envelope, so `--meta --select name` gives `{"result": {"name": ...}, "credit_cost": ..., "mcp_version": ...}`.

## `hgi tools list`

`hgi tools list --json` prints `{base_url, mcp_version, server, fetched_at, from_cache, count, tools: [...]}`. Each tool has `name`, `verb` (`call` or `run`), `read_only` (`true`, `false` or `null` when the server gave no annotation), `description`, `required`, `parameters` and the full `input_schema`. The list is cached for 15 minutes per server, organization and user; `--refresh` asks the server. The served MCP version comes from the server (`X-MCP-Version`).

On a terminal or with `-f table|csv`, `tools list` prints `name`, `verb`, `required`, `description` (table descriptions are shortened to their first line) and the MCP version on stderr.

## `hgi usage`

`hgi usage [--since <when>] [--by tool|label|day|call]` reads the local credit ledger (no sign-in, no network) and keeps only rows for the current base URL's host, so staging and production never mix. The JSON value is a top-level array.

- `--by tool` (default), `--by label`, `--by day`: one row per key, `{<key>, calls, credits, zero_cost_calls, unknown_cost_calls}`. `credits` sums the reported costs; `zero_cost_calls` counts calls that cost `0` (a server-side cache hit or a free tool); `unknown_cost_calls` counts calls whose cost the server did not report, which are not in `credits`. `tool` and `label` rows are sorted by `credits` descending, then key; `day` rows (`YYYY-MM-DD` in this machine's time zone) by date. Unlabeled calls have `label: null`.
- `--by call`: the ledger rows themselves, oldest first, with the record keys below. `hgi usage --by call -f csv` is the raw ledger as CSV.
- `--since`: `2026-11-01`, `2026-11-01T09:00` (local time unless a zone such as `Z` or `+02:00` is given), `today` (local midnight), or `24h` / `7d`. Without it, all history.

Stdout carries only data, and credits stay numeric in every machine format. On stderr, every run prints `Local to this machine: calls made by hgi here, not your organization's bill.`, plus a note when nothing has been recorded yet or the ledger is disabled (`HGI_LEDGER=off`; the result is then `[]`), and a warning with the count of malformed lines skipped (a torn last line, hand edits). In `table` format only, a `0` in `credits` reads `0 (server cache or free tool)`, `label: null` reads `(none)`, and a footnote under the table explains `zero_cost_calls` and `unknown_cost_calls`.

### The ledger record

The ledger (`~/.config/hgi/ledger.jsonl`, see [security](security.md#the-credit-ledger)) is JSON Lines, one object per tool call that got a result back, keys in this order:

```json
{"v":1,"ts":"2026-11-04T17:03:12.481Z","host":"phoenix.hginsights.com","verb":"call","tool":"company_firmographic","label":"resolve","credit_cost":2,"budget_id":null,"mcp_version":"v2","status":"ok"}
```

`v` is the format version; `ts` is UTC with milliseconds; `host` is the server host (and port); `verb` is `call` or `run`; `label` is `--label` or `null`; `credit_cost` is the server's `_meta.creditCost`, `null` when not reported (never `0`); `budget_id` is `HGI_BUDGET_ID` or `null`; `mcp_version` may be `null`; `status` is `ok` or `tool_error` (an `isError` result, including `credit_limit_exceeded`). This is a versioned interface: version 1 may gain new keys, and existing keys keep their meaning. Readers should ignore keys they do not know.

## Safety notes

- **CSV and spreadsheets.** Cells are written as the data is. A value that starts with `=`, `+`, `-` or `@` (third-party text can) is read as a formula by Excel and Google Sheets. Open untrusted exports as text, or prefix such cells yourself.
- **Terminals.** On a terminal, `table`, `csv` and `yaml` output and human-readable errors have control characters and escape sequences replaced by visible `\xNN` forms, so a tool result cannot rewrite your screen, retitle your window or write your clipboard. JSON and JSONL on a terminal additionally rewrite C1 control characters and bidirectional overrides as `\\uXXXX` escapes, which keeps the document valid and the values identical. YAML, table and CSV on a terminal replace control characters, lone carriage returns, C1 controls and invisible formatting marks (bidi overrides, zero-width space, BOM) with visible `\\xNN` / `\\uNNNN` forms. A lone carriage return is shown as `\\x0d`.

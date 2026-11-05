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

## `hgi call --ids` (batches)

With `--ids`, `hgi call` prints **one row per input line, in input order**, instead of one result:

```json
{"input": "0a1b2c...", "result": {"company_id": "a1b2c...", "...": "..."}}
{"input": "example.com", "error": {"code": "not_found", "message": "No company for this domain in the response."}}
```

- `input` is the line as you wrote it (trimmed). A duplicate line repeats its row at each position.
- `result` is the matching entry from the tool's response: the response's single top-level array-of-objects property named by the tool's output schema, else its `companies` array. Id inputs match an entry's `company_id`, else `requested_hg_id`, else `organization_id`, compared lowercased with leading zeros removed. Domain inputs match `company_domain`, compared lowercased without scheme, leading `www.` or path.
- `error.code` is `not_found` (the server left the input out), `unexpected_response` (the response has no array to match against), or the code of the failed batch call (for example `tool_error`). Error messages are redacted like every other `hgi` error.
- **The default format is JSONL, on a terminal or not.** JSONL rows stream as each batch returns. `-f json` prints one array of rows; `-f csv|yaml|table` format the list of rows. Those, and `--out`, are written once when the run ends (or, on a fatal stop, with the rows so far).
- `--select` trims each row's `result`; `input` and `error` are always kept.
- **`--meta` does not wrap stdout** with `--ids`. stdout stays pure rows, and `--meta` adds one summary object on stderr at the end: `{"calls", "rows", "row_errors", "credit_cost", "calls_without_cost"}`. `credit_cost` sums the costs the calls reported; `calls_without_cost` counts calls that reported none, so the sum is a lower bound.
- The credit line on stderr is printed once, with the total, at the end (and before a fatal error).
- On a terminal, progress (`hgi: batch 3/40`) goes to stderr. It is never printed when stderr is not a terminal.

## `hgi tools list`

`hgi tools list --json` prints `{base_url, mcp_version, server, fetched_at, from_cache, count, tools: [...]}`. Each tool has `name`, `verb` (`call` or `run`), `read_only` (`true`, `false` or `null` when the server gave no annotation), `description`, `required`, `parameters` and the full `input_schema`. The list is cached for 15 minutes per server, organization and user; `--refresh` asks the server. The served MCP version comes from the server (`X-MCP-Version`).

On a terminal or with `-f table|csv`, `tools list` prints `name`, `verb`, `required`, `description` (table descriptions are shortened to their first line) and the MCP version on stderr.

## Safety notes

- **CSV and spreadsheets.** Cells are written as the data is. A value that starts with `=`, `+`, `-` or `@` (third-party text can) is read as a formula by Excel and Google Sheets. Open untrusted exports as text, or prefix such cells yourself.
- **Terminals.** On a terminal, `table`, `csv` and `yaml` output and human-readable errors have control characters and escape sequences replaced by visible `\xNN` forms, so a tool result cannot rewrite your screen, retitle your window or write your clipboard. JSON and JSONL on a terminal additionally rewrite C1 control characters and bidirectional overrides as `\\uXXXX` escapes, which keeps the document valid and the values identical. YAML, table and CSV on a terminal replace control characters, lone carriage returns, C1 controls and invisible formatting marks (bidi overrides, zero-width space, BOM) with visible `\\xNN` / `\\uNNNN` forms. A lone carriage return is shown as `\\x0d`.

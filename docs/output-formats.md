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

## `hgi call --all-pages`

`--all-pages` fetches every page of an offset-paged tool, one call at a time, and prints **one merged result in the server's shape**, as if the server had returned every row at once. `--max-pages <n>` caps the pages per page object (default 10, page 1 included). **Each extra page is a separate, billed call.**

Which tools can be paged is read from the tool's schemas, never its name:

- the input schema has an `offset` property of type `integer`;
- the output has **page objects**: the result itself if it qualifies, otherwise each item of its one top-level array whose items qualify (`companies[]` on batch tools). A page object has exactly one array-of-objects property (its rows), plus `has_more` or `hasMore`, a total, or both;
- the **total** is a numeric `total`, `total_count` or `totalCount`; otherwise the one numeric `total_*` property whose `_`-separated name has the rows property's name as a whole segment (`installs` → `total_installs_count`). None, or more than one, means no total. `count` is never a total;
- the **page size** is the `limit` or `max_results` value in `--input`, else that property's schema `default`, else unknown. A tool declaring both has no known page size.

Anything else is refused before anything is sent (exit 2, `details.reason: "not_pageable"`).

**Stop rule**, per page object, after each page: stop when `has_more`/`hasMore` is `false`, the page has no rows, the page has fewer rows than a known page size, the rows so far reach the total, or `--max-pages` pages were fetched for it. `has_more: true` alone never keeps paging past a short page, an empty page or the total. Otherwise the next page is the original input plus `offset` = rows so far.

**Batch tools.** Page 1 is the call as given. Follow-ups go only for companies that are not finished, because `offset` applies to every company in a call:

- with two or more values across `hg_ids` and `domains`, one call per company: the original input with `hg_ids`/`domains` replaced by that company's value as you wrote it (`{"hg_ids": ["<id>"], "offset": n}`), other filters kept. Entries are matched like `--ids` rows: `company_id`, else `requested_hg_id`, else `organization_id` for ids (lowercased, leading zeros removed), `company_domain` for domains (lowercased, no scheme, `www.` or path);
- otherwise, when page 1 returned exactly one entry (the company the input named, if it named one), the original input plus `offset`; every follow-up must again return exactly that one company;
- an entry that can't be tied to exactly one input, a page 1 with several entries and nothing to split on, or a follow-up that doesn't return exactly that one company, is not followed up and is marked `unmatched`. hgi never guesses which company a page belongs to.

**The merged result.** Rows are appended to each page object's rows array. Its other fields (`has_more`, counts) are those of the last page fetched for it; for batch tools the top level is page 1's. Each page object gains:

- `pages_fetched`: the pages that contributed to it;
- `truncated: true` and `truncated_reason` when it did not finish: `max_pages`, `unmatched`, or the `error.code` of the later page that failed (see [exit codes](exit-codes.md#partial-output-from---all-pages)).

`--select`, `-f` and `--out` apply to the merged result, also when a later page failed and a partial result is printed. The credit line on stderr is printed once, with the sum of the reported costs (`null`/`unknown` when no page reported one). With `--meta` the envelope adds `pages_fetched` (the `tools/call` requests sent) and `calls_without_cost` (calls that reported no cost, so `credit_cost`, the sum, is a lower bound):

```json
{"result": {...}, "credit_cost": 6, "mcp_version": "v2", "pages_fetched": 3, "calls_without_cost": 0}
```

Without `--all-pages`, `--meta` is unchanged. `--all-pages` is not available with `--ids` or on `hgi run`.

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

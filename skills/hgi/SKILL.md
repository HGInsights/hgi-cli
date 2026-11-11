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
7. **Show a plan before working through a list.** When the work needs more than one batch (see `## Recipes`), first run one sample batch and report its `credit_cost`. Then show the plan: the calls, the number of batches, and the total estimated by extrapolating from the sample. **Wait for the user's go-ahead** before running the rest. Estimate only from the reported `credit_cost`, never from a price list; a figure from a past run may appear only as an example, labelled "observed".

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

## Recipes

These recipes name tools as examples. Before each one:

- **Confirm the tools.** Check every tool a recipe names in `hgi tools list --json`. If one is missing, skip that step and tell the user which tool is unavailable; never substitute a guess.
- **Take the batch size from the schema.** Read `maxItems` on `hg_ids` or `domains`, and the maximum of `limit`, `max_results` and `offset`, in the tool's `input_schema`. Don't hard-code them.
- **Keep batches stable.** The server caches identical inputs for 30 days (7 for search), and a cached call costs nothing (observed). Sort ids and keep the same batches, so a re-run is free. Changing one id in a batch makes the whole batch a new input.
- **Missing is not zero.** No installs, no intent, or a company left out of a batch response means unknown, not zero. Record it as unknown; don't score the account down.
- **Show a plan first** for more than one batch (Rule 7).
- Paging and batching are manual for now: a hand-written page loop and sorted id batches, as below.

### Match an account list

**Tools:** `search_companies`, `company_firmographic`. Confirm them in `hgi tools list --json`; if one is missing, skip that step and tell the user which tool is unavailable.
**Batch:** read `maxItems` on `hg_ids` in `company_firmographic`'s `input_schema`.
**Order:**

1. `search_companies` per account: the name, the HQ country and a revenue floor (USD), `limit` small. It returns only `hg_id`, `name`, `domain`, `domain_normalized`.
2. Collect the candidate `hg_id`s, sort them, and confirm them with `company_firmographic` in batches of `hg_ids`: name, `country_code`, `employees_total`, `revenue_total`, `company_level`.
3. Keep the row whose country and size fit. Don't roll up to the global HQ or corporate parent blindly: HG lists Legrand Lebanon as Legrand's global HQ, and the French state as EDF's parent. Use `company_level` and the parent fields only after a sanity check.

```bash
hgi call search_companies --input '{"company_identifiers":{"name":"Accor"},"firmographics":{"country_codes":[{"ids":["FR"],"inclusion_method":"ANY_PRESENT"}],"revenue":{"min":1000000000}},"limit":5}'
hgi call company_firmographic --input '{"hg_ids":["<id1>","<id2>"]}' --select companies.company_id,companies.firmographics.name,companies.firmographics.country_code,companies.firmographics.company_level
```

### Score fit and propensity

**Tools:** `company_technographic`, `company_intent`, `list_intent_topics`. Confirm them in `hgi tools list --json`; if one is missing, skip that step and tell the user which tool is unavailable.
**Batch:** read `maxItems` on `hg_ids` in `company_technographic`'s `input_schema`, and the maximum of `max_results` and `offset`. `company_intent` takes one company per call.
**Order:**

1. **Fit:** `company_technographic` on a sorted batch of `hg_ids`, filtered (`vendor_names`, `product_names` or `category_ids`) so pages stay small. Page with `offset`. Stop on a short page (fewer rows than `max_results`), once `total_installs_count` is reached, or at the schema's `offset` maximum. Don't stop on `has_more` alone: it can be wrong at page boundaries. At the `offset` maximum, report the result as partial and narrow the filter.
2. **Topics:** resolve curated topic names to ids with `list_intent_topics`.
3. **Intent:** `company_intent` on the company's web domain (`company_domain`), not only its HQ id: intent is observed on web domains. In one run, Accor had 0 topics on its HQ id and 18 on `accor.com` (observed; counts change over time). Check `company.id` and `company.name` in the response: a domain can resolve to a subsidiary.
4. **Baseline:** large companies are active on about 70% of the ~20,000-topic catalogue (observed), so a raw topic count measures size, not interest. Compare the curated topics (`topic_ids`) with the company's own unfiltered summary. A summary with `topic_ids` counts only those topics. `fields:["summary"]` without a topic filter rejects `granularity` (422). When you request `fields:["topics"]`, pass `granularity:"global"`: the default is one row per state, which counts a topic several times.

```bash
# technographics page loop (needs jq); page size and offset maximum come from the schema
dir=$(mktemp -d)   # a fresh directory per run, so concurrent runs never share files
schema=$(hgi tools list --json | jq '.tools[] | select(.name=="company_technographic") | .input_schema.properties')
max=$(jq '.max_results.maximum' <<<"$schema"); maxoff=$(jq '.offset.maximum' <<<"$schema")
ids='["<id1>","<id2>"]'; off=0   # one sorted batch of at most hg_ids.maxItems ids
while [ "$ids" != "[]" ]; do
  if [ "$off" -gt "$maxoff" ]; then echo "partial: offset maximum reached for $ids" >&2; break; fi
  hgi call company_technographic --input "{\"hg_ids\":$ids,\"vendor_names\":[\"<vendor>\"],\"max_results\":$max,\"offset\":$off}" -f json > "$dir/tech-$off.json" || break
  # next page only for companies that filled this page and are short of their stated total, sorted
  ids=$(jq -c --argjson max "$max" --argjson off "$off" '[.companies[] | select(.installs_count == $max and $off + $max < .total_installs_count) | .company_id] | sort' "$dir/tech-$off.json")
  off=$((off + max))
done
hgi call company_intent --input '{"company_domain":"accor.com"}'
hgi call company_intent --input '{"company_domain":"accor.com","fields":["summary"],"topic_ids":["<topic id>"]}'
```

### Size wallet from spend

**Tools:** `company_spend`, `get_product_category`. Confirm them in `hgi tools list --json`; if one is missing, skip that step and tell the user which tool is unavailable.
**Batch:** read `maxItems` on `hg_ids` in `company_spend`'s `input_schema`, and the maximum of `max_results`.
**Order:**

1. Use the `hg_id`s from the matching recipe, sorted.
2. To size one area, resolve its category ids first with `get_product_category`, as `company_spend`'s description says. Don't pass guessed `category_names`: a name that matches nothing returns 0 rows without an error.
3. One `company_spend` call per batch of `hg_ids`, with `category_ids` set in that same call, not filtered afterwards.
4. Page with `max_results` and `offset` only when `all_count` exceeds the rows returned, with the same stop rule as technographics.
5. Rows are per country, and categories form a tree through `category_parent_id` (Total IT → Total External IT → Software, …). Sum across countries, never a parent with its children.

```bash
hgi call company_spend --input '{"hg_ids":["<id1>","<id2>"],"category_ids":["<category id>"]}' --select companies.company_id,companies.spend.all
```

## Data semantics

Verified with one live call per tool. "Scope" is what a call returns by default.

| Tool | Default scope | Nullable fields (what null means) |
|---|---|---|
| `search_companies` | global: all countries unless `country_codes` filters the HQ country | no field came back null in the verification call; treat a missing field as unknown |
| `company_firmographic` | country: one record per entity, in its own `country_code` | `corporate_parent_id`, `corporate_parent_name`, `parent_id`, `domestic_parent_id`, `domestic_parent_name`: none (no parent above it); `fortune_500_rank`, `forbes_2000_rank`: unknown |
| `company_technographic` | global: default rows have `country_code: null`; `granularity` or `country_codes` give per-country rows | `country_code`: a global or unattributed row, not missing data; `product_category_level4_name`, `product_category_level5_name`: none (the category tree is shallower) |
| `company_intent` | global: `summary` only, for the resolved entity across all geographies; with `fields:["topics"]`, one row per state unless `granularity:"global"` | no field came back null in the verification call; treat a missing field as unknown |
| `company_spend` | country: every row has a `country_code` | no field came back null in the verification call; treat a missing field as unknown |

Not null, but easy to misread:

- A batch response leaves out companies it didn't match. A left-out company is unknown, not zero.
- `company_domain` is `""` when you query by `hg_ids`.
- `company_intent` on a domain answers for whichever company the domain resolves to: `accor.com` resolved to an Accor subsidiary in Australia, not the group HQ.

**HG ids** are hex strings, normally 32 characters and uppercase in responses. An id can come back with its leading zero dropped, as 31 characters: seen on a spend `category_id`, and on company ids (observed). The `hg_ids` inputs accept 31 or 32 characters. Upper-case ids and left-pad them to 32 with `0` before comparing or joining.

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

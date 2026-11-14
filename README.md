# hgi

`hgi` is a command-line client for the HG Insights MCP server. It is built first for AI coding agents (Claude Code and similar) and second for developers and GTM engineers who want company, contact, technology, intent and spend data in a terminal or a script.

It is a thin client: it signs you in through your browser, then lists and runs the tools the server offers you. It never hard-codes the tool list.

## Install

macOS and Linux only. Windows is not supported (`npm` refuses the install). Pick one route:

```bash
brew install hginsights/tap/hgi          # macOS and Linux, no Node.js needed
npm install -g @hginsights/hgi           # needs Node.js 22.19 or newer
# or download hgi-vX.Y.Z-<os>-<arch>.tar.gz from the GitHub release, unpack, and put `hgi` on your PATH
hgi --version
```

The prebuilt binaries (macOS arm64 and x64, Linux x64 and arm64) bundle their own Node.js, so they are large (about 110-130 MB). On Linux they need glibc 2.28 or newer; on Alpine use the npm route. The macOS binaries are not Developer ID signed or notarized, so install them with Homebrew (or npm). If you download a macOS tarball through a browser, macOS will block it until you run `xattr -d com.apple.quarantine hgi` once; `curl`, Homebrew and npm downloads are not affected.

### Verify what you installed

```bash
sha256sum -c SHA256SUMS --ignore-missing      # shasum -a 256 -c on macOS
gh attestation verify hgi-vX.Y.Z-<os>-<arch>.tar.gz --repo HGInsights/hgi-cli
# npm route: run `npm audit signatures` in a project that depends on @hginsights/hgi
npm view @hginsights/hgi dist.attestations    # provenance attestation for the package
```

Each release also attaches a CycloneDX SBOM. See [SECURITY.md](SECURITY.md) and [docs/releasing.md](docs/releasing.md).

### Upgrading

`hgi` has no self-update command. Upgrade it the way you installed it:

```bash
brew update && brew upgrade hginsights/tap/hgi   # Homebrew: refresh the tap first, or brew won't see the new version
npm install -g @hginsights/hgi@latest            # npm: keep the -g, a plain `npm i` installs into the current directory
# tarball: download the new release and replace the `hgi` on your PATH
hgi --version
```

If `hgi --version` still shows the old version, `which -a hgi` lists every copy on your PATH and the first one wins. Keep a single install: run `brew uninstall hgi` or `npm uninstall -g @hginsights/hgi` to remove the one you don't use.

`hgi skill install` copies the agent skill, so the copy doesn't change when you upgrade. Run `hgi skill install --force` afterwards to pick up the new version's skill.

### Troubleshooting

- **`hgi auth login` ends on a `403 Forbidden` page.** Open a private window (or clear your browser's cookies for phoenix.hginsights.com, or for the host in your `HGI_BASE_URL`), sign in at https://phoenix.hginsights.com (or your `HGI_BASE_URL`) first, then open the URL `hgi auth login` printed in that same window. Sign-in still finishes in the terminal. If `hgi` already timed out, run `hgi auth login` again and open the new URL in that window.
- The binary and the npm install both honor `NODE_OPTIONS`. If your shell exports `--require` or `--import` hooks (for example a tracer), `hgi` can fail to start: run `env -u NODE_OPTIONS hgi ...`.

## Quick start

```bash
hgi auth login                       # opens your browser; sign in and approve
hgi auth whoami                      # who you are and which organization is billed
hgi tools list                       # what the server offers you, each marked call or run
hgi call company_enrich --input '{"domain":"acme.com"}'
```

`hgi call` runs read-only tools (lookups). `hgi run` runs tools that change state or start work, and tools that do not declare themselves read-only. Using the wrong verb fails and tells you the right one. There is no `--yes` flag: that is deliberate, so an agent permission rule on `hgi call *` approves only lookups.

On a machine without a browser:

```bash
hgi auth login --no-browser          # prints a URL; open it anywhere, then paste back the URL it redirects to
```

## Commands

| Command | What it does |
|---|---|
| `hgi auth login [--no-browser]` | sign in with OAuth (authorization code + PKCE) |
| `hgi auth whoami` | show the signed-in user and organization (asks the server) |
| `hgi auth logout [--force]` | revoke the session on the server and delete the local credentials |
| `hgi tools list [--refresh] [--json]` | the tools the server offers you, with `call`/`run`, required fields, schemas and the MCP version |
| `hgi call <tool> --input '<json>'` | run a read-only tool |
| `hgi call <tool> --ids @file` | run a read-only batch tool over a list of HG ids or domains, one row per line |
| `hgi call <tool> --all-pages` | fetch every page of an offset-paged tool and print one merged result; each extra page is a separate, billed call ([details](docs/output-formats.md#hgi-call---all-pages)) |
| `hgi run <tool> --input '<json>'` | run a state-changing tool |
| `hgi usage [--since <when>] [--by tool\|label\|day\|call]` | what `hgi` spent on this machine, from the local credit ledger (no sign-in needed) |
| `hgi budget status` / `hgi budget reset` | what this run has spent against `hgi call --max-credits`, and starting the count over (local only) |
| `hgi skill install` | copy the agent skill to `~/.claude/skills/hgi` |

Options for `call`, `run` and `tools list`:

- `--input <json>`: a JSON object. `@file.json` reads a file, `-` reads stdin.
- `-f, --format json|jsonl|csv|yaml|table`: JSON when piped, a table on a terminal. See [output formats](docs/output-formats.md).
- `--select a,b.c`: keep only those fields.
- `--out <file>`: write the complete result to a new file.
- `--meta`: print `{result, credit_cost, mcp_version}`.
- `--timeout <seconds>`: per-request timeout (default 120).
- `--label <label>` (`call` and `run`): tag the call in the credit ledger, for example by pipeline stage. 1 to 64 characters from `A-Z a-z 0-9 . _ : / -`.

Options for `call` only (batching):

- `--ids @file` / `--ids -`: one HG id or domain per line, from a file or stdin. Blank lines and `#` lines are skipped. A line with a dot is a domain, anything else an HG id.
- `--ids-column <name>`: with `--ids`, read the file as CSV with a header row and take the ids from that column.
- `--batch-size <n>`: send fewer ids per call than the tool's limit (its schema's `maxItems`, or 25).

Global: `--base-url`, `--debug` (tokens are always masked), `--json-errors`.

The credit cost of each call is printed on stderr after it runs (`credit_cost: 3`). There is no price before the call.

Each call that gets a result back from the server (a success or a tool error) is also recorded in a local credit ledger, and `hgi usage` sums it. A call whose outcome is unknown (the connection failed after it was sent) has no result and is not recorded.

```bash
hgi call company_enrich --input '{"domain":"acme.com"}' --label enrich
hgi usage --since 7d            # credits and calls by tool, this machine only
hgi usage --by label --since today
hgi usage --by call -f csv      # one row per call, for a spreadsheet
```

`hgi usage` shows what `hgi` spent on this machine, not your organization's bill. Calls that cost `0` (a server-side cache hit or a free tool) are counted apart from calls whose cost the server did not report. See [output formats](docs/output-formats.md#hgi-usage) and [security](docs/security.md#the-credit-ledger).

## Using it from an AI coding agent

This repository ships a Claude Code skill: [`skills/hgi/SKILL.md`](skills/hgi/SKILL.md), also reachable at `.claude/skills/hgi/` inside this repo. To use it from any project:

```bash
hgi skill install
```

Recommended Claude Code permissions: allow lookups, ask for everything else. Put them in your user settings (`~/.claude/settings.json`) or a trusted project's `.claude/settings.json`.

```json
{
  "permissions": {
    "allow": ["Bash(hgi call *)", "Bash(hgi tools list *)", "Bash(hgi auth whoami)"],
    "ask": ["Bash(hgi run *)"]
  }
}
```

**Read [the security notes](docs/security.md) before giving an agent shell access.** A 30-day refresh token is stored in a `0600` file that any program running as you can read. That is an accepted, documented risk.

## Scripts and errors

Failures have distinct exit codes and a stable JSON error on stderr; see [exit codes](docs/exit-codes.md).

```bash
hgi call company_enrich --input '{"domain":"acme.com"}' --select name,employees | jq .
hgi call search_companies --input '{"query":"saas"}' -f csv --out saas.csv
```

### Looking up a whole list

`--ids` splits a list into batches the tool accepts, sends them one at a time, and prints one JSONL row per input line, in your file's order, as soon as each batch returns:

```bash
hgi call company_spend --ids @hg_ids.txt --input '{"category_names":["CRM"]}' > spend.jsonl
hgi call company_spend --ids @accounts.csv --ids-column hg_id --input '{"category_names":["CRM"]}'
```

Each row is `{"input": "<your line>", "result": {...}}` or `{"input": "<your line>", "error": {"code": "not_found", "message": "..."}}`, so joining back to your spreadsheet works even when the server drops leading zeros from ids or you wrote `https://www.Example.com/about`. Duplicate lines are sent once and get their row repeated. Running the same file again sends identical batches. The rest of `--input` is sent with every batch. A failed batch marks its rows with the error, the run continues, and the exit code is 3. Out of credits, an expired sign-in or an unreachable server stops the run at once, with the rows so far kept (see [exit codes](docs/exit-codes.md#partial-output-from---ids)). The total credit cost is printed once at the end.

## Configuration

| Variable | Meaning |
|---|---|
| `HGI_BASE_URL` | server origin (default `https://phoenix.hginsights.com`). Credentials are kept per server, so staging and production do not mix |
| `HGI_DEBUG=1` | same as `--debug` |
| `BROWSER` | command used to open the sign-in page |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` | proxy settings |
| `NODE_EXTRA_CA_CERTS` | extra CA bundle for corporate TLS inspection |
| `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` | move `~/.config/hgi` and `~/.cache/hgi` |
| `HGI_CONFIG_DIR`, `HGI_CACHE_DIR` | explicit directories (must not be inside a git working tree) |
| `HGI_LEDGER` | credit ledger path (default `<config dir>/ledger.jsonl`; must not be inside a git working tree), or `off` to keep no history |
| `HGI_MAX_CREDITS` | run cap for `hgi call`, same as `--max-credits` (the flag wins). See [Run cap](docs/exit-codes.md#run-cap) |
| `HGI_BUDGET_ID` | the run a capped `hgi call` counts against (default: the parent process id); when set, also recorded with each call in the credit ledger, to group the calls of one run |

`hgi` sends the User-Agent `hgi/<version>` and has no telemetry: it talks only to the server you configure, and sends nothing to HG Insights or anyone else about how you use it.

## Compatibility

`hgi` builds its command surface from the server's tool list at run time, so server tool changes do not need an `hgi` release. See [docs/compatibility.md](docs/compatibility.md) for the supported MCP protocol versions and what happens when the server drops a tool or capability.

## Development

```bash
npm ci
npm run build && npm run check   # typecheck, lint, unit + end-to-end tests (e2e needs dist/)
npm run test:e2e   # builds, then runs only the end-to-end suite against a fake server
bash scripts/verify-allowlist.sh   # headless Claude Code: `hgi call *` runs, `hgi run *` is held back
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).

# hgi

`hgi` is a command-line client for the HG Insights MCP server. It is built first for AI coding agents (Claude Code and similar) and second for developers and GTM engineers who want company, contact, technology, intent and spend data in a terminal or a script.

It is a thin client: it signs you in through your browser, then lists and runs the tools the server offers you. It never hard-codes the tool list.

> **Status:** pre-release. The repository is private until the open-source release is approved.

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

### Troubleshooting

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
| `hgi run <tool> --input '<json>'` | run a state-changing tool |
| `hgi skill install` | copy the agent skill to `~/.claude/skills/hgi` |

Options for `call`, `run` and `tools list`:

- `--input <json>`: a JSON object. `@file.json` reads a file, `-` reads stdin.
- `-f, --format json|jsonl|csv|yaml|table`: JSON when piped, a table on a terminal. See [output formats](docs/output-formats.md).
- `--select a,b.c`: keep only those fields.
- `--out <file>`: write the complete result to a new file.
- `--meta`: print `{result, credit_cost, mcp_version}`.
- `--timeout <seconds>`: per-request timeout (default 120).

Global: `--base-url`, `--debug` (tokens are always masked), `--json-errors`.

The credit cost of each call is printed on stderr after it runs (`credit_cost: 3`). There is no price before the call.

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

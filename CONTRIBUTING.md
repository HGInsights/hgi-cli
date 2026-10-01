# Contributing

## Setup

```bash
npm ci
npm run check        # tsc --noEmit, eslint, vitest (unit + e2e)
```

Node.js 22.19 or newer (the minimum `undici` requires). macOS and Linux.

`npm test` runs everything. The end-to-end tests spawn the built binary (`dist/bin.js`) against an in-process fake server (`test/support/fake-server.ts`), so run `npm run build` first or use `npm run test:e2e`, which builds for you.

## Ground rules

- **Never print a token.** Every error and debug line goes through `redact()` (`src/redact.ts`). If you add output that could carry server text, route it through the error renderer. Tests scan full sessions for tokens; keep them green.
- **Every failure maps to a documented exit code** (`src/errors.ts`, `docs/exit-codes.md`). Add the code, the doc row and a test together.
- **Do not retry a `tools/call` after it was sent** unless the failure is provably pre-dispatch (see `src/mcp/transport-fetch.ts`).
- **Do not use the SDK's `Client.listTools()` / `callTool()`.** They install output-schema validators that fail after the tool already ran. Use `client.request(..., schema)` as `src/mcp/session.ts` does.
- **No hard-coded tool names or lists.** Tool lists depend on the caller and the server version.
- **Keep `hgi call` a lookup-only verb.** Anything that lets it write or read outside what a lookup needs must be refused or documented in `docs/security.md`.
- Tests that touch files use a temporary directory outside the repository (the workspace guard refuses config directories inside a git working tree).

## Dependencies

Dependabot proposes minor and patch updates only, grouped into one pull request per ecosystem per week (`.github/dependabot.yml`). Major version bumps (TypeScript, ESLint, Vitest, undici, the MCP SDK, GitHub Actions) are done by hand, one at a time, because they need deliberate testing and can be mutually incompatible. `npm-shrinkwrap.json` is committed so `npm install -g` installs exactly the versions CI tested; regenerate it with `npm install --package-lock-only` when you change dependencies.

## Layout

```
src/auth/        OAuth (PKCE, loopback, discovery, token manager, credentials store, login)
src/mcp/         MCP session (SDK), retry rules, tools cache, schema validation, result extraction
src/output/      formats, --select, --out, input-file guards
src/commands/    commander wiring for auth, tools, call/run, skill
skills/hgi/      the agent skill (also reachable at .claude/skills/hgi)
test/support/    fake server, CLI runner, simulated browser
docs/            security, exit codes, output formats
```

## Releases

See [docs/releasing.md](docs/releasing.md). In short: the release workflow builds signed binaries, publishes to npm with provenance and opens the Homebrew PR, from a `vX.Y.Z` tag. Do not store release secrets in the repository; they live in the `release` environment.

Binary-related changes (anything under `packaging/`, `scripts/`, `src/commands/skill.ts`, the build config) must pass the binary end-to-end suite:

```bash
bash scripts/build-binaries.sh            # darwin on macOS, linux on Linux (or name targets)
bash scripts/test-binary-e2e.sh dist-bin/hgi-darwin-arm64   # deletes dist/ so nothing can fall back to the npm build
bash scripts/smoke-binary.sh dist-bin/hgi-darwin-arm64
```

After editing `skills/hgi/SKILL.md`, run `npm run gen:skill` and commit `src/generated/skill-md.ts`.

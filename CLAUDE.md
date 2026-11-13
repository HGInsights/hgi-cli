# CLAUDE.md

Guidance for Claude Code (and, through the `AGENTS.md` symlink, Codex) working
in this repository. Edit only this file.

## What this is

`hgi`, a command-line client for the HG Insights MCP server, written in
TypeScript for Node.js 22.19 or newer, on macOS and Linux. It ships as an npm
package, a Homebrew formula and single-executable binaries. See `README.md` for
what it does and `CONTRIBUTING.md` for how it is built.

## Commands

- `npm ci`: install exactly what `npm-shrinkwrap.json` pins.
- `npm run typecheck && npm run lint`: the fast check.
- `npm run build && npm test`: the tests. The end-to-end tests spawn the built
  `dist/bin.js` against an in-process fake server, so build first
  (`npm run test:e2e` builds for you; `npm run test:unit` needs no build).
- `npm run check`: typecheck, lint and test together.
- After editing `skills/hgi/SKILL.md`: `npm run gen:skill`, and commit
  `src/generated/skill-md.ts` (CI fails when it is stale).
- Binary changes (`packaging/`, `scripts/`, `src/commands/skill.ts`, the build
  config): the binary end-to-end suite in `CONTRIBUTING.md`.

## Ground rules

`CONTRIBUTING.md` → "Ground rules" is binding: never print a token (everything
goes through `redact()`), every failure has a documented exit code, no retry
of a `tools/call` after it was sent, no SDK `listTools()`/`callTool()`, no
hard-coded tool names, `hgi call` stays lookup-only, and tests write only to
temporary directories outside the repository. `docs/security.md`,
`docs/exit-codes.md`, `docs/output-formats.md` and `docs/compatibility.md`
record the decisions behind them.

## GitHub

- Always pass `--repo HGInsights/hgi-cli` to `gh`. The default branch is
  `main`; never push to it directly.
- Pull requests merge by **squash only**, with conventional-commit titles
  (`fix: …`, `feat(scope): …`, `chore(deps): …`). Every PR needs an approving
  review from `@HGInsights/maintainers` and the required checks green.
- This repository is public: no secrets, internal hostnames or customer data
  in code, commits, issues or PR bodies.

## AI SDLC

`.claude/` holds the AI software development lifecycle, seeded from
[HGInsights/claude-code-setup](https://github.com/HGInsights/claude-code-setup)
`templates/`. The long warnings in the agent and command files each record a
production failure, so don't trim them. `.claude/skills/hgi` (the `hgi` agent
skill) is separate.

Flow: `/grill-me` (a fuzzy idea) → `/task-to-github-issue <KEY>` (a Jira
ticket → a GitHub issue with `### Story N:` stories and `**Story N:**`
criteria; two sign-off gates) → `/fix-issue <N>` (worktree → plan → plan
review → implement → code review → `/create-pr` → post-PR review → CI gate).

- **Reviewers** (`.claude/agents/plan-reviewer.md`, `code-reviewer.md`):
  Codex runs first through `.claude/hooks/codex-safe.sh`, which strips
  credentials, closes stdin and bounds the run; an in-model review takes over
  when Codex can't run, and says so. Only in-scope `[critical]`/`[high]`
  findings block; the rest are triaged fix, accept or defer, against the
  review bar written into the reviewer prompts. At most 3 rounds.
- **Never let Codex compute or fetch its own diff.** The agents materialize
  the diff and the linked issue with local `git`/`gh` and inline the bytes.
- **Questions** follow `.claude/skills/runbooks/operator-questions.md`:
  `AskUserQuestion` only, tagged, answerable on its own, one decision each.
  Technical ones go to the `decision-consult` agent first.
- **Releases**: `/release [patch|minor|major|X.Y.Z] [--skip-rc]` runs
  `docs/releasing.md` → "Cutting a release": bump PR, rc, tag, watch the
  release workflow, release notes, tap PR checksums. It asks before every
  tag push and never approves the `release` environment itself.
- **Dev docs**: `/fix-issue` writes `dev/active/issue-<N>/` (gitignored) and
  archives it to `dev/completed/`. `context.md` → `## Implementation Summary`
  is the recovery record after a compaction or a crash.
- **Jira**: tickets for this repo live in Jira project `AL` with the label
  `hgi-cli`. Use the `jira` CLI (`jira issue view KEY --plain`).
- **The AI harness.** These commands also run unattended as background
  sessions under an internal orchestrator. The `: harness-step …` lines, the
  `<!-- harness-review: … -->` PR-body marker, `WAITING-ON:` lines
  (`.claude/skills/runbooks/external-waits.md`) and
  `.claude/skills/runbooks/bot-review-rounds.md` are its interface; each is a
  no-op without it.

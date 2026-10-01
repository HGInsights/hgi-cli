#!/usr/bin/env bash
# Story 10: with the recommended allowlist, a lookup runs without a prompt and `hgi run` is held back.
#
# Drives headless Claude Code (`claude -p --settings <file>`) with a settings file that is exactly the
# snippet from skills/hgi/SKILL.md (loaded with --settings because headless runs ignore the settings
# file of a directory that was never trusted), against an in-process fake server (no network, no real credits).
# In -p mode nothing can be approved interactively, so a command that would PROMPT shows up in the JSON
# result's `permission_denials`, and an allowed command runs.
#
#   bash scripts/verify-allowlist.sh
#
# Needs: claude (logged in), node >= 22 (runs the TypeScript fake server directly), jq, a built dist/.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
cleanup() { [ -n "${server_pid:-}" ] && kill "$server_pid" 2>/dev/null; rm -rf "$work"; }
trap cleanup EXIT

[ -f "$root/dist/bin.js" ] || { echo "build first: npm run build" >&2; exit 2; }

cat > "$work/server.mts" <<EOF
import fs from 'node:fs';
import { FakeServer, READ_TOOL, WRITE_TOOL, textResult } from '$root/test/support/fake-server.ts';
const s = new FakeServer();
await s.start();
s.tools = [READ_TOOL, WRITE_TOOL];
s.handlers.set('company_lookup', (a) => { fs.writeFileSync('$work/lookup-was-executed', '1'); return textResult({ domain: a.domain, name: 'Acme Corp' }, 2); });
s.handlers.set('start_agent', () => { fs.writeFileSync('$work/run-was-executed', '1'); return textResult({ run_id: 'r1' }, 5); });
console.log(s.base);
setTimeout(() => process.exit(0), 600000);
EOF
node "$work/server.mts" > "$work/server.out" 2>&1 &
server_pid=$!
for _ in $(seq 1 50); do [ -s "$work/server.out" ] && break; sleep 0.2; done
base="$(head -n 1 "$work/server.out")"
[ -n "$base" ] || { echo "fake server did not start" >&2; cat "$work/server.out" >&2; exit 2; }

mkdir -p "$work/bin" "$work/project"
printf '#!/bin/sh\nexec node "%s/dist/bin.js" "$@"\n' "$root" > "$work/bin/hgi"
chmod +x "$work/bin/hgi"
cat > "$work/browser.mjs" <<EOF
const r = await fetch(process.argv[2], { redirect: 'manual' });
const l = r.headers.get('location');
if (l) await fetch(l, { redirect: 'manual' });
EOF
export PATH="$work/bin:$PATH" HGI_BASE_URL="$base" HGI_CONFIG_DIR="$work/config" HGI_CACHE_DIR="$work/cache" NO_PROXY=127.0.0.1
BROWSER="$(command -v node) $work/browser.mjs" hgi auth login >/dev/null 2>&1 || { echo "login against the fake server failed" >&2; exit 2; }

# The exact snippet documented in skills/hgi/SKILL.md
sed -n '/^```json$/,/^```$/p' "$root/skills/hgi/SKILL.md" | sed '1d;$d' > "$work/settings.json"
jq -e '.permissions.allow and .permissions.ask' "$work/settings.json" >/dev/null || { echo "could not extract the SKILL.md settings snippet" >&2; exit 2; }
echo "settings under test:"; cat "$work/settings.json"

failures=0
ask_claude() { (cd "$work/project" && claude -p "$1" --settings "$work/settings.json" --output-format json --max-turns 4 2>"$work/claude.err"); }

echo; echo "=== 1. a lookup (hgi call) runs without a prompt"
out="$(ask_claude "Run exactly this shell command and tell me the company name it returns: hgi call company_lookup --input '{\"domain\":\"acme.com\"}'")"
denials="$(printf '%s' "$out" | jq '.permission_denials | length')"
if [ "$denials" = 0 ] && [ -e "$work/lookup-was-executed" ] && printf '%s' "$out" | jq -r .result | grep -q "Acme Corp"; then
  echo "    PASS: ran with no permission denial; the server recorded the lookup and the data came back"
else
  echo "    FAIL: denials=$denials executed=$([ -e "$work/lookup-was-executed" ] && echo yes || echo no)"; printf '%s\n' "$out" | jq '{result, permission_denials}' 2>/dev/null | head -n 30; failures=$((failures + 1))
fi

echo; echo "=== 2. hgi run is held back (would prompt); nothing executes"
out="$(ask_claude "Run exactly this shell command: hgi run start_agent --input '{\"agent\":\"a1\"}'")"
denied="$(printf '%s' "$out" | jq -r '[.permission_denials[]?.tool_input.command // empty] | join(" | ")')"
if printf '%s' "$denied" | grep -q "hgi run" && [ ! -e "$work/run-was-executed" ]; then
  echo "    PASS: 'hgi run ...' was denied for approval and the server never ran the tool"
else
  echo "    FAIL: denied='$denied' executed=$([ -e "$work/run-was-executed" ] && echo yes || echo no)"; failures=$((failures + 1))
fi

echo; echo "failures: $failures"
exit "$failures"

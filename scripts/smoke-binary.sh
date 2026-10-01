#!/usr/bin/env bash
# Smoke-test a packaged hgi binary. The binary is copied into a fresh directory outside the
# repository first, so nothing can resolve a file next to the checkout (the skill embed in
# particular must not depend on the repo's skills/ directory).
#
#   bash scripts/smoke-binary.sh dist-bin/hgi-linux-x64
#
# Needs only a POSIX shell, sed, cmp and grep (no Node), so it runs in a bare container.
set -euo pipefail

src="${1:?usage: smoke-binary.sh <path to hgi binary>}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/home" "$work/skills"
cp "$src" "$work/bin/hgi"
chmod 755 "$work/bin/hgi"
hgi="$work/bin/hgi"
export HGI_CONFIG_DIR="$work/home/config" HGI_CACHE_DIR="$work/home/cache" HOME="$work/home"
cd "$work"

expected="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$root/package.json" | head -n 1)"
actual="$("$hgi" --version 2>"$work/version.err")"
[ "$actual" = "$expected" ] || { echo "hgi --version printed '$actual', expected '$expected'" >&2; exit 1; }
[ ! -s "$work/version.err" ] || { echo "hgi --version wrote to stderr:" >&2; cat "$work/version.err" >&2; exit 1; }

"$hgi" --help >/dev/null

"$hgi" skill install --dir "$work/skills" >/dev/null
cmp -s "$work/skills/hgi/SKILL.md" "$root/skills/hgi/SKILL.md" || { echo "installed SKILL.md differs from skills/hgi/SKILL.md" >&2; exit 1; }

set +e
"$hgi" auth whoami >"$work/whoami.out" 2>"$work/whoami.err"
code=$?
set -e
[ "$code" = 4 ] || { echo "hgi auth whoami exited $code, expected 4 (login_required)" >&2; cat "$work/whoami.err" >&2; exit 1; }
grep -q '"login_required"' "$work/whoami.err" || { echo "whoami error body is not login_required" >&2; exit 1; }

echo "ok: $src is hgi $actual"

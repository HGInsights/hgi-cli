#!/usr/bin/env bash
# Story 11: `npm i -g` of the packed tarball in a clean prefix yields a working `hgi --version`.
#
#   bash scripts/smoke-install.sh              build, pack and install (development)
#   bash scripts/smoke-install.sh <file.tgz>   install exactly that tarball (release pipeline)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cd "$root"
if [ -n "${1:-}" ]; then
  tarball="$(basename "$1")"
  cp "$1" "$work/$tarball"
else
  npm run build --silent
  tarball="$(npm pack --silent --pack-destination "$work" | tail -n 1)"
fi

# Capture the listing first: `tar | grep -q` under pipefail fails when grep exits early and tar gets a closed pipe.
listing="$(tar -tzf "$work/$tarball")"
grep -qx "package/npm-shrinkwrap.json" <<<"$listing" || {
  echo "the npm tarball does not ship npm-shrinkwrap.json (add it to package.json files)" >&2
  exit 1
}

prefix="$work/prefix"
mkdir -p "$prefix"
npm install --global --silent --prefix "$prefix" --no-audit --no-fund "$work/$tarball"

expected="$(node -p "require('./package.json').version")"
actual="$("$prefix/bin/hgi" --version)"
if [ "$actual" != "$expected" ]; then
  echo "hgi --version printed '$actual', expected '$expected'" >&2
  exit 1
fi

"$prefix/bin/hgi" --help >/dev/null
"$prefix/bin/hgi" skill install --dir "$work/skills" >/dev/null
test -f "$work/skills/hgi/SKILL.md"

echo "ok: hgi $actual installed from $tarball into a clean prefix"

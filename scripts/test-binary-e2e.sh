#!/usr/bin/env bash
# Run the end-to-end suite against a packaged binary instead of the npm build.
#
#   bash scripts/test-binary-e2e.sh dist-bin/hgi-linux-x64
#
# dist/ is deleted first, so a test that bypasses HGI_BIN and falls back to `node dist/bin.js` fails
# loudly instead of silently exercising the npm build. The binary is copied outside the repository.
set -euo pipefail

src="${1:?usage: test-binary-e2e.sh <path to hgi binary>}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp "$src" "$work/hgi"
chmod 755 "$work/hgi"
rm -rf "$root/dist"
cd "$root"
HGI_BIN="$work/hgi" npx --no-install vitest run test/e2e

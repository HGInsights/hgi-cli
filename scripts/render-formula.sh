#!/usr/bin/env bash
# Render the Homebrew formula for a release from its SHA256SUMS.
#
#   bash scripts/render-formula.sh 0.1.0 release/SHA256SUMS > Formula/hgi.rb
#   bash scripts/render-formula.sh 0.1.0-rc.1 release/SHA256SUMS --local-dir "$PWD/release" > hgi.rb
#
# Without --local-dir the version must be plain MAJOR.MINOR.PATCH (release candidates are never
# published to the tap). --local-dir points the download urls at file:// copies of the tarballs so CI
# can `brew install` a candidate before anything is published; the output is never committed anywhere.
# Fails if any of the four platform tarballs is missing from SHA256SUMS.
set -euo pipefail

version="${1:?usage: render-formula.sh <version> <SHA256SUMS>}"
sums="${2:?usage: render-formula.sh <version> <SHA256SUMS>}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
local_dir=""
if [ "${3:-}" = "--local-dir" ]; then local_dir="${4:?--local-dir needs a directory}"; fi

if [ -z "$local_dir" ]; then
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "refusing to render a formula for '$version' (final releases only)" >&2; exit 1; }
else
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]] || { echo "unexpected version '$version'" >&2; exit 1; }
fi

sum_for() {
  local line
  line="$(grep -E "^[0-9a-f]{64}  hgi-v${version//./\\.}-$1\.tar\.gz\$" "$sums" || true)"
  [ "$(printf '%s\n' "$line" | grep -c .)" = 1 ] || { echo "SHA256SUMS must list hgi-v$version-$1.tar.gz exactly once" >&2; exit 1; }
  printf '%s' "${line%% *}"
}

# Resolve every checksum first: `exit` inside a command substitution would only leave the subshell.
sum_darwin_arm64="$(sum_for darwin-arm64)" || exit 1
sum_darwin_x64="$(sum_for darwin-x64)" || exit 1
sum_linux_arm64="$(sum_for linux-arm64)" || exit 1
sum_linux_x64="$(sum_for linux-x64)" || exit 1

base="https://github.com/HGInsights/hgi-cli/releases/download/v$version"
[ -z "$local_dir" ] || base="file://$local_dir"

sed \
  -e "s#https://github.com/HGInsights/hgi-cli/releases/download/v@VERSION@#$base#" \
  -e "s/@VERSION@/$version/g" \
  -e "s/@SHA256_DARWIN_ARM64@/$sum_darwin_arm64/" \
  -e "s/@SHA256_DARWIN_X64@/$sum_darwin_x64/" \
  -e "s/@SHA256_LINUX_ARM64@/$sum_linux_arm64/" \
  -e "s/@SHA256_LINUX_X64@/$sum_linux_x64/" \
  "$root/packaging/homebrew/hgi.rb.tmpl"

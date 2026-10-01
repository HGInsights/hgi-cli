#!/usr/bin/env bash
# Write SHA256SUMS for every regular file in a directory (relative names, sorted).
#
#   bash scripts/make-checksums.sh release/            # writes release/SHA256SUMS
#   (cd release && sha256sum -c SHA256SUMS)            # how a user verifies
set -euo pipefail

dir="${1:?usage: make-checksums.sh <dir>}"
cd "$dir"
rm -f SHA256SUMS
if command -v sha256sum >/dev/null 2>&1; then sum=(sha256sum); else sum=(shasum -a 256); fi
find . -maxdepth 1 -type f ! -name SHA256SUMS -print | sed 's#^\./##' | LC_ALL=C sort | while read -r f; do
  "${sum[@]}" "$f"
done > SHA256SUMS
cat SHA256SUMS

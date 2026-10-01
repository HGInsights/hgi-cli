#!/usr/bin/env bash
# Turn assembled binaries into release assets.
#
#   bash scripts/package-release.sh <version> <bin-dir> <out-dir>
#
# <bin-dir> holds hgi-<os>-<arch> binaries (signed already, for darwin). Produces in <out-dir>:
#   hgi-v<version>-<os>-<arch>.tar.gz   hgi, LICENSE, THIRD_PARTY_NOTICES, NODE_LICENSE
#   hgi-v<version>.sbom.cdx.json
#   hginsights-hgi-<version>.tgz        the npm tarball (built with scripts disabled, then packed)
#   SHA256SUMS                          over everything above
#
# No credentials are read here; this runs in the job that holds no secrets.
set -euo pipefail

version="${1:?usage: package-release.sh <version> <bin-dir> <out-dir>}"
bins="$(cd "${2:?}" && pwd)"
mkdir -p "${3:?}"
out="$(cd "$3" && pwd)"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

pkg_version="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' package.json | head -n 1)"
[ "$pkg_version" = "$version" ] || { echo "package.json is $pkg_version, release is $version" >&2; exit 1; }

source "$root/scripts/lib-node.sh"
node_bin="$(fetch_node "$(host_target)")"
node_license="$(dirname "$(dirname "$node_bin")")/LICENSE"
[ -f "$node_license" ] || { echo "missing $node_license" >&2; exit 1; }

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
node scripts/make-notices.mjs --out "$stage/THIRD_PARTY_NOTICES"

shopt -s nullglob
found=0
for bin in "$bins"/hgi-*; do
  target="${bin##*/hgi-}"
  case "$target" in darwin-arm64|darwin-x64|linux-x64|linux-arm64) ;; *) continue ;; esac
  found=$((found + 1))
  dir="$stage/$target"
  mkdir -p "$dir"
  cp "$bin" "$dir/hgi"
  chmod 755 "$dir/hgi"
  cp LICENSE "$dir/LICENSE"
  cp "$stage/THIRD_PARTY_NOTICES" "$dir/THIRD_PARTY_NOTICES"
  cp "$node_license" "$dir/NODE_LICENSE"
  tar -czf "$out/hgi-v$version-$target.tar.gz" -C "$dir" hgi LICENSE THIRD_PARTY_NOTICES NODE_LICENSE
done
[ "$found" -gt 0 ] || { echo "no hgi-<os>-<arch> binaries in $bins" >&2; exit 1; }

node scripts/make-sbom.mjs --node "$node_bin" --out "$out/hgi-v$version.sbom.cdx.json"

# `npm pack --ignore-scripts` skips `prepack`, so dist/ must already be built (npm run build).
[ -f dist/bin.js ] || { echo "dist/bin.js is missing: run 'npm run build' before packaging" >&2; exit 1; }
npm pack --ignore-scripts --silent --pack-destination "$out" >/dev/null
bash scripts/make-checksums.sh "$out"

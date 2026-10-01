#!/usr/bin/env bash
# Assemble self-contained hgi binaries (Node single executable applications).
#
#   bash scripts/build-binaries.sh [target ...]      targets: darwin-arm64 darwin-x64 linux-x64 linux-arm64
#
# With no arguments, builds every target this host can assemble: Linux hosts build the linux-*
# targets; macOS hosts build the darwin-* targets (the signature must be removed with `codesign`,
# which exists only on macOS). Output: dist-bin/hgi-<target>.
#
# The official Node tarball is verified against the SHA-256 pinned in packaging/node-sha256.json
# before anything is extracted. The SEA blob is produced by the pinned Node for the HOST platform
# (it must be the same Node version as the injected binary) and is portable across targets because
# code cache and snapshot are disabled in packaging/sea-config.json.
#
# This script reads no credentials. darwin outputs get an ad-hoc signature (`codesign -s -`), which is
# all Apple Silicon needs to run a binary. They are NOT Developer ID signed or notarized: Homebrew,
# curl and npm installs are unaffected, but a tarball downloaded through a browser is blocked by
# Gatekeeper until the user clears the quarantine attribute (documented in the README).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
out="$root/dist-bin"
mkdir -p "$out"

source "$root/scripts/lib-node.sh"
host="$(host_target)"
host_os="${host%%-*}"

if [ "$#" -gt 0 ]; then targets=("$@"); else
  case "$host_os" in
    darwin) targets=(darwin-arm64 darwin-x64) ;;
    linux) targets=(linux-x64 linux-arm64) ;;
    *) echo "unsupported host OS: $host_os" >&2; exit 1 ;;
  esac
fi

host_node="$(fetch_node "$host")"

echo "bundling"
npx --no-install tsup --config tsup.sea.config.ts >/dev/null
"$host_node" --experimental-sea-config packaging/sea-config.json >/dev/null
blob="$root/build/sea/hgi.blob"

for target in "${targets[@]}"; do
  case "$target" in
    darwin-*) [ "$host_os" = darwin ] || { echo "$target must be assembled on macOS (codesign is macOS-only)" >&2; exit 1; } ;;
  esac
  node_bin="$(fetch_node "$target")"
  dest="$out/hgi-$target"
  rm -f "$dest"
  cp "$node_bin" "$dest"
  chmod u+w "$dest"
  inject=(npx --no-install postject "$dest" NODE_SEA_BLOB "$blob" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2)
  case "$target" in
    darwin-*)
      codesign --remove-signature "$dest"
      "${inject[@]}" --macho-segment-name NODE_SEA >/dev/null
      codesign --force --sign - "$dest"
      ;;
    *) "${inject[@]}" >/dev/null ;;
  esac
  chmod 755 "$dest"
  echo "built $dest ($(du -h "$dest" | cut -f1))"
done

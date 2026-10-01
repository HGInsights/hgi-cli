# Shared helpers: fetch the pinned official Node.js, verified against packaging/node-sha256.json.
# Source this file; it expects $root to be the repository root.
#
#   fetch_node <target>   -> prints the path of the extracted node binary
#   host_target           -> darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64

NODE_CACHE="${HGI_BUILD_CACHE:-$root/build/node}"

host_target() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "$(uname -m)" in
    arm64|aarch64) arch=arm64 ;;
    x86_64|amd64) arch=x64 ;;
    *) echo "unsupported host architecture: $(uname -m)" >&2; return 1 ;;
  esac
  echo "$os-$arch"
}

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

pinned_node() { # <target> -> "<version> <archive name> <sha256>"
  node -e 'const m=require("./packaging/node-sha256.json");const f=m.files[process.argv[1]];if(!f){process.exit(2)}console.log(m.version+" "+f.name+" "+f.sha256)' "$1"
}

fetch_node() {
  local target="$1" version name sum dir archive
  mkdir -p "$NODE_CACHE"
  read -r version name sum < <(cd "$root" && pinned_node "$target") || { echo "no pinned Node for $target" >&2; return 1; }
  dir="$NODE_CACHE/${name%.tar.*}"
  if [ ! -x "$dir/bin/node" ]; then
    archive="$NODE_CACHE/$name"
    if [ ! -f "$archive" ]; then curl -fsSL "https://nodejs.org/dist/$version/$name" -o "$archive"; fi
    if [ "$(sha256 "$archive")" != "$sum" ]; then
      echo "SHA-256 mismatch for $name (expected $sum)" >&2
      rm -f "$archive"
      return 1
    fi
    tar -xf "$archive" -C "$NODE_CACHE"
  fi
  echo "$dir/bin/node"
}

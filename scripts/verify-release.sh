#!/usr/bin/env bash
# Verify a published release on THIS machine through one install route, then run the core
# acceptance checks (login, whoami, tools list, one read-only call, logout, no token leak) against
# the INSTALLED hgi, not a source build.
#
#   HGI_BASE_URL=<server to test against> \
#     bash scripts/verify-release.sh v0.1.0 --route binary|npm|brew [--skip-real-run]
#
# Run it once per route on a clean macOS machine and a clean Linux machine, from a checkout of the
# same tag (only the scripts are used). Needs: gh (authenticated), jq, curl, and for the npm route
# Node 22.19+ and npm. The real run opens a browser for the sign-in consent.
set -euo pipefail

tag="${1:?usage: verify-release.sh vX.Y.Z --route binary|npm|brew [--skip-real-run]}"
shift
route=""
real_run=true
repo="${HGI_RELEASE_REPO:-HGInsights/hgi-cli}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --route) route="${2:?}"; shift ;;
    --skip-real-run) real_run=false ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$route" ] || { echo "pass --route binary|npm|brew" >&2; exit 2; }
version="${tag#v}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failures=0
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; failures=$((failures + 1)); }
info() { printf '      %s\n' "$*"; }

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) target=darwin-arm64 ;;
  Darwin-x86_64) target=darwin-x64 ;;
  Linux-x86_64) target=linux-x64 ;;
  Linux-aarch64|Linux-arm64) target=linux-arm64 ;;
  *) echo "unsupported platform: $(uname -sm)" >&2; exit 2 ;;
esac
echo "verifying $tag via '$route' on $(uname -sm) ($target)"

case "$route" in
  binary)
    mkdir -p "$work/bin" "$work/dl"
    gh release download "$tag" --repo "$repo" --dir "$work/dl" --pattern "hgi-$tag-$target.tar.gz" --pattern SHA256SUMS --pattern "hgi-$tag.sbom.cdx.json"
    (cd "$work/dl" && { command -v sha256sum >/dev/null 2>&1 && sha256sum -c SHA256SUMS --ignore-missing || shasum -a 256 -c SHA256SUMS --ignore-missing 2>&1 | grep -v 'No such file'; }) \
      && pass "checksums match SHA256SUMS" || fail "checksum mismatch"
    if gh attestation verify "$work/dl/hgi-$tag-$target.tar.gz" --repo "$repo" >/dev/null 2>&1; then pass "build provenance attestation verifies"; else fail "gh attestation verify failed"; fi
    [ -s "$work/dl/hgi-$tag.sbom.cdx.json" ] && jq -e '.bomFormat == "CycloneDX"' "$work/dl/hgi-$tag.sbom.cdx.json" >/dev/null && pass "SBOM attached and is CycloneDX" || fail "SBOM missing or malformed"
    tar -xzf "$work/dl/hgi-$tag-$target.tar.gz" -C "$work/bin"
    [ -x "$work/bin/hgi" ] && pass "tarball unpacks to an executable hgi" || fail "hgi is not executable after unpacking"
    export PATH="$work/bin:$PATH"
    if [ "$(uname -s)" = Darwin ]; then
      codesign --verify --strict --verbose=2 "$work/bin/hgi" 2>/dev/null && pass "ad-hoc signature intact (required for Apple Silicon to run the binary)" || fail "codesign verification failed"
      info "macOS binaries are not Developer ID signed or notarized: a browser-downloaded tarball needs 'xattr -d com.apple.quarantine hgi' once; brew, curl and npm are unaffected"
    fi
    ;;
  npm)
    mkdir -p "$work/prefix" "$work/project"
    npm install --global --prefix "$work/prefix" --no-audit --no-fund "@hginsights/hgi@$version" >/dev/null
    export PATH="$work/prefix/bin:$PATH"
    pkgdir="$work/prefix/lib/node_modules/@hginsights/hgi"
    [ -f "$pkgdir/npm-shrinkwrap.json" ] && pass "package ships npm-shrinkwrap.json (tested dependency versions)" || fail "npm-shrinkwrap.json missing from the installed package"
    # `npm audit signatures` audits the dependencies of the PROJECT it runs in, so hgi must be a
    # dependency of a throwaway project (inside hgi's own directory it would audit only hgi's deps).
    (cd "$work/project" && npm init -y >/dev/null && npm install --no-audit --no-fund "@hginsights/hgi@$version" >/dev/null)
    if (cd "$work/project" && npm audit signatures >"$work/audit.txt" 2>&1); then pass "npm audit signatures: registry signatures verify for hgi and its dependencies"; else fail "npm audit signatures failed"; sed 's/^/      /' "$work/audit.txt"; fi
    if npm view "@hginsights/hgi@$version" dist.attestations --json 2>/dev/null | jq -e '.provenance != null or .url != null' >/dev/null; then pass "the registry holds a provenance attestation for @hginsights/hgi@$version"; else fail "no provenance attestation on @hginsights/hgi@$version"; fi
    ;;
  brew)
    command -v brew >/dev/null || { echo "Homebrew is not installed on this machine" >&2; exit 2; }
    brew install hginsights/tap/hgi
    ;;
  *) echo "unknown route: $route" >&2; exit 2 ;;
esac

installed="$(command -v hgi || true)"
[ -n "$installed" ] && pass "hgi resolves to $installed" || { fail "hgi is not on PATH after the $route install"; exit 1; }
case "$route" in
  binary) [ "$installed" = "$work/bin/hgi" ] || fail "hgi resolved to $installed, not the binary under test" ;;
  npm) [ "$installed" = "$work/prefix/bin/hgi" ] || fail "hgi resolved to $installed, not the npm install under test" ;;
  brew) case "$installed" in "$(brew --prefix)"/*) ;; *) fail "hgi resolved to $installed, not the Homebrew install under test (is an older hgi earlier on PATH?)" ;; esac ;;
esac
[ "$(hgi --version 2>/dev/null)" = "$version" ] && pass "hgi --version prints $version" || fail "hgi --version is '$(hgi --version 2>&1)', expected $version"
[ -z "$(hgi --version 2>&1 >/dev/null)" ] && pass "hgi --version writes nothing to stderr" || fail "hgi --version wrote to stderr"

if $real_run; then
  : "${HGI_BASE_URL:?set HGI_BASE_URL to the server to test against for the real run}"
  echo "real run (core checks) against $HGI_BASE_URL with $installed"
  if HGI_BIN="$installed" HGI_REALRUN_MODE=core bash "$root/scripts/real-run-staging.sh" | tee "$work/real-run.txt"; then pass "core acceptance checks pass with this install"; else fail "core acceptance checks failed (see output above)"; fi
fi

printf '\n%s: %s failure(s) for %s via %s on %s\n' "$([ "$failures" = 0 ] && echo OK || echo FAILED)" "$failures" "$tag" "$route" "$target"
exit "$failures"

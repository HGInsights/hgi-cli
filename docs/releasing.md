# Releasing hgi

How a release is built, what it needs, and how to go from "private repository" to "published `v0.1.0`". The pipeline is `.github/workflows/release.yml`.

## What a release contains

| Asset | Notes |
|---|---|
| `hgi-vX.Y.Z-{darwin-arm64,darwin-x64,linux-x64,linux-arm64}.tar.gz` | `hgi`, `LICENSE`, `THIRD_PARTY_NOTICES`, `NODE_LICENSE`. macOS binaries carry an ad-hoc signature only (see [macOS](#macos-homebrew-and-npm-not-developer-id-signed)) |
| `SHA256SUMS` | over every asset |
| `hgi-vX.Y.Z.sbom.cdx.json` | CycloneDX: production npm dependencies plus the bundled Node.js runtime and its components |
| `hginsights-hgi-X.Y.Z.tgz` | the exact npm tarball that is published (with provenance) |
| attestations | GitHub build-provenance attestation for every asset |

The binaries are Node.js single-executable applications: the official Node.js release pinned in `packaging/node-sha256.json` (verified by SHA-256 before use) with the bundled program injected. They are 110-130 MB. Linux binaries need glibc 2.28 or newer; Alpine/musl is unsupported (use `npm install -g`). Node 22 reaches end of life on 2027-04-30; rebuild on Node security releases and move to the next LTS before then.

## Trust boundaries in the pipeline

| Job | Holds | Runs |
|---|---|---|
| `build-linux`, `build-darwin`, `package` | no secrets | `npm ci --ignore-scripts`, build, package |
| `attest` | attestation OIDC token | verifies checksums, attests; no repository code |
| `npm-publish` (`release` environment) | npm OIDC token | publishes the prebuilt, smoke-tested tarball with `--ignore-scripts` |
| `homebrew-pr` (`release` environment) | GitHub App credential, scoped to the tap | renders the formula, opens a PR (never pushes to the tap's `main`) |

Release jobs need the `release` GitHub environment, which only `v*` **tags** may deploy to. Manual runs of the workflow are dry runs: no secrets, nothing published.

## Secrets (environment `release`)

Store these **only after the repository is public and `scripts/configure-repo-security.sh --apply` has run**. On a private GitHub Free repository any writer can read a repository secret by editing a workflow.

| Secret | What | Who provides it |
|---|---|---|
| `TAP_APP_CLIENT_ID`, `TAP_APP_PRIVATE_KEY` | the GitHub App that opens the formula PR on `HGInsights/homebrew-tap` | org owner |

npm needs no stored secret: it uses trusted publishing. There are no Apple credentials: macOS binaries are not Developer ID signed.

### What the secrets are

`TAP_APP_CLIENT_ID` and `TAP_APP_PRIVATE_KEY` belong to a GitHub App that is installed on `HGInsights/homebrew-tap` only, with **Contents: read and write** and **Pull requests: read and write** and nothing else. The workflow mints a short-lived token limited to that one repository on every release; the app never pushes to the tap's `main`, it only opens a pull request. The tap should have a ruleset on `main` requiring a pull request (it is public, so this works on the Free plan). How the app is created and who holds its key is an organization-admin matter and is not documented in this repository.

## One-time npm bootstrap

### Prerequisite

The `@hginsights` npm organization must exist, with at least two owners who have 2FA enabled.

### Publish the placeholder and connect the workflow

Trusted publishing is configured per existing package, so the package must exist first. Do this immediately before the rehearsal tag, as an owner of the scope:

1. `npm publish --access public` a placeholder version `0.0.0` (the registry makes the first version `latest` whatever the tag).
2. On npmjs.com, package settings: add a trusted publisher: repository `HGInsights/hgi-cli`, workflow `release.yml`, environment `release`.
3. `npm deprecate @hginsights/hgi@0.0.0 "placeholder; use 0.1.0 or newer"`.

Verify these npm steps against npm's current documentation when you do them; the rules have changed recently. The first real test of the OIDC exchange is the `-rc.1` publish; if it fails with an authentication error, check the trusted-publisher settings first (the publish job deliberately has no `registry-url`, so no placeholder token is configured). Trusted publishing needs npm 11.5.1 or newer, so the publish job runs on Node 24 (which bundles npm 11) and fails if the bundled npm is older; it never downloads npm at publish time.

## Cutting a release

1. Bump `version` in `package.json` (and `npm-shrinkwrap.json`: `npm install --package-lock-only`), open a PR, merge it.
2. **Rehearse** with a release candidate: bump to `X.Y.Z-rc.1`, merge, tag `vX.Y.Z-rc.1`. This does everything for real (GitHub prerelease, smoke tests on all four platforms, `brew install` of the rendered formula, npm publish under dist-tag `next` with provenance) except opening the Homebrew PR.
3. Run `scripts/verify-release.sh vX.Y.Z-rc.1 --route binary|npm` on clean machines.
4. Bump to `X.Y.Z`, merge, tag `vX.Y.Z`. This publishes `latest` and opens the tap PR; merge it after checking the checksums match.
5. Run `scripts/verify-release.sh vX.Y.Z --route brew|binary|npm` on a clean macOS and a clean Linux machine and paste the output into the tracking issue.
6. After the first release: add a `compat-previous-release` CI job that runs the previous release's binary against the current fake-server fixtures (`docs/compatibility.md` promises it from `v0.1.1`).

Dry run at any time: Actions > Release > Run workflow (builds and packages everything; nothing is published).

## Making the repository public (first release only)

In this order. Each step is a gate for the next.

0. **Before anything else:** make sure the `@hginsights` npm organization and the tap GitHub App exist (see the prerequisites above). Make sure the release team (`--release-team`) has at least two members and every team named in `.github/CODEOWNERS` has write access to the repository (the script checks both and refuses to `--apply` otherwise).
1. Final scan: `gitleaks git --log-opts="--all"`, and manually review Actions logs, artifacts, and the PR, issue and review comment threads (gitleaks does not read comments). Delete old workflow runs and artifacts.
2. Legal and security sign-off ([oss-approval.md](oss-approval.md)), recorded in the tracking issue **with the approved commit SHA**. Any later commit needs a re-check.
3. Make the repository public.
4. `bash scripts/configure-repo-security.sh --release-team <slug> --apply`.
5. Prove the controls: push a scratch branch containing a fake secret (expect it to be blocked or alerted) and attempt a direct push to `main` (expect a rejection). Paste the results into the tracking issue, then delete the scratch branch.
6. Add the secrets above to the `release` environment.
7. npm bootstrap.
8. Tag `vX.Y.Z-rc.1`; 9. verify and evaluate; 10. tag `vX.Y.Z`; 11. verify on clean machines.

## macOS: Homebrew and npm, not Developer ID signed

**Decision:** macOS binaries are not Developer ID signed or notarized. Apple Developer credentials, a notarization step and an installer package add real cost and lead time for little user-visible value here, because the supported macOS routes avoid the problem:

- **Homebrew** and **`curl`** downloads do not set macOS's quarantine attribute, so Gatekeeper never assesses the binary and it runs without a warning.
- **npm** runs under Node, which is already signed.
- The binaries carry an **ad-hoc signature** (`codesign -s -`), which is all Apple Silicon needs to execute a binary. The release smoke job checks that it is intact.

What users lose: a macOS tarball downloaded through a **browser** is quarantined and blocked by Gatekeeper until the user runs `xattr -d com.apple.quarantine hgi` once. The README and the release notes say so. Some enterprise endpoint-security or MDM policies only allow notarized binaries; those users should install through npm.

**Revisit** if a customer needs a notarized binary: add a Developer ID Application certificate, a signing job that holds the credentials and installs nothing from npm, and a notarization step (`notarytool`). Nothing else in the pipeline needs to change.

## Rollback

- GitHub release: edit it to a draft or delete it (`gh release delete`); delete the tag only if no one has consumed it.
- npm: versions are immutable. `npm deprecate @hginsights/hgi@X.Y.Z "<reason>"` and publish a fixed patch version.
- Homebrew: close the tap PR, or revert the formula commit.
- A compromised GitHub App key: generate a new key, update `TAP_APP_PRIVATE_KEY`, then delete the compromised key (in that order, so the app is never without a working key).

# Compatibility policy

`hgi` is a thin client. It does not carry a list of tools, parameters or result shapes: it asks the server what is available, every time it acts.

## What this means for releases

- **A change to the server's tool set does not need an `hgi` release.** New tools appear in `hgi tools list` and can be called straight away; removed tools stop being listed and fail with `unknown_tool` (exit 2).
- `hgi call` and `hgi run` read a fresh tool list on every invocation and refresh the local cache from it. `hgi tools list` alone reads that cache (up to 15 minutes old); `hgi tools list --refresh` skips it. A tool listing printed before any call can therefore be briefly stale.
- Which verb a tool needs comes from its `readOnlyHint` annotation on that fresh list. A tool that stops advertising `readOnlyHint: true` is treated as state-changing (`run`); `hgi call` on it fails with exit 10 and names `hgi run`.
- Tool input is validated against the schema the server advertises. A tool that gains an optional field keeps accepting old inputs. A tool that gains a required field rejects old inputs with exit 2 and names the field.
- The credit cost comes from `_meta.creditCost` on a successful result. If a server stops sending it, the call still succeeds and the cost is reported as unknown.

An `hgi` release is needed only when the **protocol** changes in a way the bundled MCP SDK cannot speak, or when the OAuth flow changes.

## Supported MCP protocol versions

`hgi` uses the MCP TypeScript SDK pinned in `npm-shrinkwrap.json` and speaks the protocol versions that SDK supports:

- `2025-11-25`
- `2025-06-18`
- `2025-03-26`
- `2024-11-05`
- `2024-10-07`

The list above is checked against the SDK by a test, so it cannot drift from what ships. `hgi` offers the newest version and accepts the server's choice if it is on the list. The version the server actually uses is shown by `hgi tools list` (`mcp_version`). The server's own tool-set version (for example `v2`) is separate from the protocol version.

## When the server drops a capability

| The server stops... | `hgi` does |
|---|---|
| listing a tool | the tool disappears from `tools list`; calling it exits 2 (`unknown_tool`) |
| marking a tool read-only | the tool becomes `run`-only |
| sending `_meta.creditCost` | the call succeeds; cost is reported as unknown |
| supporting a protocol version `hgi` offered | the server picks another version from the list above and `hgi` follows it |
| supporting any version on the list | the connection fails with `server_unreachable` (exit 7, `details.reason: unsupported_protocol_version`) and tells you to upgrade `hgi`; it never crashes |
| the OAuth features `hgi` uses (PKCE S256, loopback redirect, client metadata document) | sign-in is rejected by the server and fails with `oauth_error` (exit 8) carrying the server's error; `hgi` does not probe for these features first |

## Deprecation

Removing an `hgi` command, flag, output field or exit code is a breaking change and ships in a new major version. Exit codes and the JSON error body are documented in [exit-codes.md](exit-codes.md) and are stable within a major version. The shipped Claude Code skill is updated in the same release as any change it describes.

## Which version works with which server

There is no minimum-server-version table, because the CLI asks the server what it supports. The only version pair that matters is the protocol list above. Releases are tagged `vX.Y.Z`; the newest release is the one tested against the current server. Node-based installs require Node.js 22.19 or newer; the prebuilt binaries bundle their own Node.js.

## How this is tested

For `v0.1.0` there is no earlier build to run against a newer server, so the test suite runs one build against two server tool sets (`test/e2e/compat.test.ts`). From `v0.1.1` the plan is for CI to also run the previous release's binary against the current test server. That job does not exist yet; it needs a first published release to test against, and is listed in the release checklist ([releasing.md](releasing.md)).

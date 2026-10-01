# Security model

`hgi` signs you in through your browser and stores a session on your machine. This page states what is stored, what protects it, and which risks are accepted.

## Accepted risk: the credentials file

`hgi auth login` writes your session to `~/.config/hgi/credentials-<host>.json`. It holds a 1-hour access token and a **30-day refresh token**, in a file with mode `0600` inside a directory with mode `0700`.

**An AI agent (or any program) running as the same operating-system user can read that file.** That is common for command-line tools that keep a login, and it is accepted for `hgi`.

- Risk owner: the Office of the CTO, HG Insights. Accepted 2026-09-30.
- What this means for you: treat any agent that runs shell commands as you as able to act as you against HG Insights for up to 30 days, until you run `hgi auth logout`.
- Future work, not in this release: shorter token lifetimes and OS keychain storage.

`hgi` never prints a token. Tokens are masked in every output, error and `--debug` log, and your agent's instructions (`SKILL.md`) tell it not to read the file.

## How the credentials file is protected

- Created atomically with mode `0600` from the first write (a temporary file opened with `O_EXCL`, then renamed), in a `0700` directory.
- A pre-existing symlink at the credentials path, or a symlinked `~/.config/hgi` directory, is refused. `hgi` never follows it.
- Stored under `~/.config/hgi/` (or `$XDG_CONFIG_HOME/hgi`), never in a project directory. `HGI_CONFIG_DIR`, `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` overrides inside a git working tree are refused.
- One file per server, and a token is only ever sent to the server it was issued by. OAuth endpoints found through discovery must be on the same origin as the base URL, and `hgi` never follows an HTTP redirect on an auth or MCP request, so a token cannot be replayed to another host.
- Several `hgi` processes share a lock around refresh, so parallel commands do not invalidate each other's sessions.

## Signing in and out

- Sign-in uses the OAuth authorization-code flow with PKCE (S256). The loopback listener binds `127.0.0.1` only, on a random port, and accepts exactly one callback with an exact `state` match. With `--no-browser`, a pasted callback URL must match the exact redirect URI and state and is used once.
- `hgi auth logout` asks the server to revoke both tokens and deletes the file. If the server cannot be reached it keeps the file and tells you so (you are **not** signed out). `--force` deletes the local file anyway and warns that the server-side session may stay valid for up to 30 days.
- A repeat `hgi auth login` revokes the previous session after saving the new one. If that revoke cannot be delivered, login still succeeds and warns you.
- After a revoke, the access token stops working at once on the userinfo endpoint. The MCP endpoint may accept it for up to about 30 seconds (the server caches validated tokens briefly).

### Residual risks

- If you suspect a token has been stolen, run `hgi auth logout` and ask your administrator or your HG Insights representative to revoke your sessions.
- A refresh response lost after the server rotated the refresh token consumes it. You will be asked to sign in again.
- The refresh lock is an advisory file lock with a 30-second stale window and an ownership check before every credential write. A process that is suspended for longer than that at an unlucky instant (for example a laptop asleep between the last check and the final rename) could still overwrite credentials a newer `hgi` process just saved. No advisory lock can exclude this. The cost is signing in again; it cannot expose a token.

## What `call` and `run` do

- `hgi call` only runs tools the server marks `readOnlyHint: true`, decided against a fresh tool list on every invocation. `hgi run` runs everything else, including tools with no annotations. There is no `--yes` flag, so a host permission rule on `hgi call *` approves only lookups.
- `--out <file>` never overwrites an existing file on `hgi call`, never follows symlinks, and refuses paths inside hgi's config and cache directories. `--input @file` refuses hgi's own credential and cache files (including through symlinks and hard links). An allowlisted agent can still write a **new** file or send any other file it can read to HG Insights as tool input; scope your allowlist accordingly.
- Credit cost is reported after each call. Credits are billed to your organization.

## Network

- `https` is required except for loopback hosts used in tests.
- Proxies are honored (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`). Corporate TLS inspection needs `NODE_EXTRA_CA_CERTS`. TLS and proxy failures name their cause.
- `hgi` sends the User-Agent `hgi/<version>` and nothing else about you. No telemetry.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting on this repository (Security tab), or contact your HG Insights representative.

# Release

Cut a release of `hgi`: bump the version, rehearse with a release candidate,
tag, watch `.github/workflows/release.yml`, fix up the release notes and check
the Homebrew tap PR. `docs/releasing.md` → "Cutting a release" is the process;
this command runs it and stops wherever a person has to act.

<!--
Written for hgi-cli, in the style of the commands seeded from
HGInsights/claude-code-setup. Keep the commentary: each warning is there
because skipping that check publishes something that can't be taken back.
-->

## Inputs

`$ARGUMENTS`, all optional:

- `patch`, `minor`, `major` or an exact `X.Y.Z`: the version to release.
  Without one, Step 2 proposes one from the commit titles.
- `--skip-rc`: go straight to the final tag. Allowed only under the rule in
  Step 2.

Run `/release` again with no arguments to pick up a release in progress. The
command works out where it is from `git` and `gh` (Step 1), so it needs no
saved state and a different session or machine can continue it.

> **What can't be undone.** A pushed `v*` tag starts a publish. npm versions
> are immutable: a bad `X.Y.Z` can only be deprecated and replaced with
> `X.Y.Z+1`. **Never push a tag without the operator's explicit yes in this
> session** (Steps 5 and 8), never move or delete a pushed tag, and never
> approve the `release` environment deployment on the operator's behalf: that
> gate exists so a person looks first.

**Step markers.** At the start of each step, run its marker line as one Bash
call of its own. `:` is the shell no-op; under the AI harness a hook records
the step, elsewhere it does nothing.

**Questions** follow `.claude/skills/runbooks/operator-questions.md`:
`AskUserQuestion` only, tagged, answerable on their own, one decision each.

Throughout, `PREV` is the newest **final** tag (`vX.Y.Z` with no `-rc`), and
`V` the version being released (no `v`).

## Step 0: Pre-flight

```bash
: harness-step '/release' 'pre-flight'
```

Stop at the first failure and say what to do about it.

1. **Permission to tag.** Only the `maintain` role (and admins) can push `v*`
   tags (`scripts/configure-repo-security.sh`, ruleset "release tags"):
   `gh api repos/HGInsights/hgi-cli --jq '.permissions | .maintain or .admin'`
   must print `true`. If not, stop before bumping anything: whoever runs the
   release needs that role.
2. **Clean, current checkout.** `git status --porcelain` is empty, then
   `git fetch origin main --tags`. Do all reading against `origin/main`,
   never a local `main`, which may be stale.
3. **`main` is green.** The latest `CI` run on `origin/main`'s head commit
   passed:
   `gh run list --repo HGInsights/hgi-cli --workflow ci.yml --branch main --commit "$(git rev-parse origin/main)" --json conclusion,status,url`.
   Pending: wait for it (poll every 60 s, at most 30 minutes). Red: stop. A
   release tagged on a red `main` fails the same way in the release workflow,
   only later.
4. **Nothing else is releasing.**
   `gh run list --repo HGInsights/hgi-cli --workflow release.yml --limit 5 --json status,headBranch,url`
   shows no run `in_progress`, `queued` or `waiting`, unless it is this
   release's own (Step 1 decides).

## Step 1: Work out where the release is

```bash
: harness-step '/release' 'locate the release'
```

Read:

- `MAIN_VER`: `git show origin/main:package.json | jq -r .version`
- `PREV`: `git tag --list 'v*' --sort=-v:refname | grep -v -- '-rc\.' | head -n 1`
- whether tag `v$MAIN_VER` exists (`git rev-parse -q --verify "refs/tags/v$MAIN_VER"`)
- an open bump PR:
  `gh pr list --repo HGInsights/hgi-cli --state open --search 'in:title "chore: release"' --json number,title,headRefName,url`

Then go to the first row that matches:

| State | Go to |
| --- | --- |
| A bump PR is open | Step 4 (wait for it) |
| No tag `v$MAIN_VER`, and `$MAIN_VER` is newer than the newest tag | Step 5 (tag it): the bump merged, the tag was never pushed |
| Tag `v$MAIN_VER` exists, its release run isn't `completed` | Step 6 (watch it) |
| Tag `v$MAIN_VER` exists, its run failed | Step 6, item 5 (a failed run) |
| `$MAIN_VER` is an rc (`V-rc.N`), its run succeeded | Step 8, "After an rc": the rehearsal is done, the final isn't bumped yet |
| `$MAIN_VER` is a final, its run succeeded, the tap PR `hgi-$MAIN_VER` is still open | Step 8, "After the final" |
| Otherwise | Step 2: a new release |

The release run for a tag is
`gh run list --repo HGInsights/hgi-cli --workflow release.yml --event push --branch "v$VER" --json databaseId,status,conclusion,url --limit 1`
(for a tag push, the run's branch is the tag name).

If `$ARGUMENTS` names a version that disagrees with a release already in
progress, say so and ask before doing anything.

## Step 2: Choose the version

```bash
: harness-step '/release' 'choose the version'
```

1. List what ships: `git log "$PREV"..origin/main --format='%h %s'`. Nothing,
   or only `chore(deps)`/`chore(ci)` bumps: say so and ask whether to release
   anyway (a dependency security fix is a fine reason; a CI bump isn't).
2. Propose `V` from the titles, under `docs/compatibility.md`: removing a
   command, flag, output field or exit code is breaking and needs a new major.
   - any `!:` title or `BREAKING CHANGE` footer: major. Before `1.0.0`, ask:
     going to `1.0.0` is a product decision, not a side effect of one commit.
   - any `feat`: minor
   - otherwise: patch

   An explicit `$ARGUMENTS` version wins, but if it is lower than the
   proposal (a `patch` over a `feat:` commit), ask.
3. **RC or not.** The rehearsal (`V-rc.1`) is the default. `--skip-rc` is
   allowed only for a patch release with no changes since `PREV` under
   `packaging/`, `scripts/`, `.github/workflows/release.yml`, or the
   dependencies (`git diff --quiet "$PREV" origin/main -- packaging scripts .github/workflows/release.yml package.json npm-shrinkwrap.json`).
   Otherwise the rehearsal runs whatever the arguments say, and you tell the
   operator why: those are the changes that break publishing, and the rc
   finds that out under npm's `next` tag instead of `latest`.
4. Confirm with one `AskUserQuestion` (`[product]`, header `Version`): the
   version, rc or not, and the list of PR titles that will ship, in the
   question text. Options: the proposal (Recommended), the next-larger bump,
   cancel.

## Step 3: Open the bump PR

```bash
: harness-step '/release' 'open the bump PR'
```

`BUMP` is `V-rc.N` for a rehearsal (N one higher than any existing
`vV-rc.*` tag, else 1) or `V` for the final.

1. `git switch -c "chore/release-$BUMP" origin/main`.
2. `npm version "$BUMP" --no-git-tag-version --ignore-scripts`. It updates `package.json` and
   both version fields at the top of `npm-shrinkwrap.json`. Check:
   `jq -r .version package.json npm-shrinkwrap.json` and
   `jq -r '.packages[""].version' npm-shrinkwrap.json` all print `$BUMP`.
   Nothing else in the tree carries the version (`src/` reads it from
   `package.json` at build time).
3. `git diff --stat` shows only those two files. If `npm` changed more than
   the version fields, stop and look: it means the shrinkwrap was out of
   step with `package.json`, which is its own PR.
4. `npm run typecheck && npm run lint`, and
   `npm audit --omit=dev --audit-level=high`. The audit is the
   `dependency audit and licenses` CI gate, and advisories land between
   releases (it is what made `v0.1.1` more than a version bump). If it fails,
   stop: the fix is a separate `chore(deps)` PR first.
5. Commit `chore: release $BUMP`, push, and open the PR:
   `gh pr create --repo HGInsights/hgi-cli --base main --title "chore: release $BUMP" --body-file …`.
   The body:
   - `## What ships`: the PR titles since `PREV` (Step 2, item 1; list
     them again when resuming), grouped Features, Fixes,
     Docs, Other, each with its `(#N)`. Leave out `chore(deps)`/`chore(ci)`
     lines unless one fixes an advisory.
   - `## Agent skill`: if `git diff --quiet "$PREV" origin/main -- skills/hgi/SKILL.md`
     fails, say the shipped skill changed and the release notes will tell
     users to run `hgi skill install --force`.
   - `## After merge`: "tag `v$BUMP`, approve the `release` environment" and,
     for a final, "merge the Homebrew tap PR once the checksums match".
   - the PR attribution footer.

## Step 4: Wait for the bump PR to merge

```bash
: harness-step '/release' 'wait for the bump PR' --waiting 'review and merge of the release bump PR'
```

The PR needs an approving review from `@HGInsights/maintainers` and green
checks; squash only. You can't approve it and you don't merge it unless the
operator tells you to.

1. Watch its checks (poll every 60 s, at most 30 minutes). A red check: read
   the log and fix it on the branch with a plain `git push` (the approval is
   lost on push, so say so).
2. Once checks are green, if it isn't merged, end the turn: say the PR is
   waiting on review, with its URL. It is the operator's own PR, so no
   `WAITING-ON` line (`.claude/skills/runbooks/external-waits.md`); the
   harness brings the session back when it changes, and otherwise the
   operator runs `/release` again after merging.
3. Merged: go on.

## Step 5: Tag

```bash
: harness-step '/release' 'tag the release'
```

1. `git fetch origin main --tags`. `SHA` is the squash commit of the bump PR:
   `gh pr view <P> --repo HGInsights/hgi-cli --json mergeCommit -q .mergeCommit.oid`.
   Check `git show "$SHA:package.json" | jq -r .version` is `$BUMP` and
   `git merge-base --is-ancestor "$SHA" origin/main` succeeds. The release
   workflow's `verify` job rejects anything else, but only after the tag is
   public.
2. Wait for `CI` on `$SHA` to pass (as in Step 0, item 3).
3. Ask (`[product]`, header `Push tag`): "Push tag `v$BUMP` on `$SHA`
   (`chore: release $BUMP`)? This starts the release workflow: <for an rc: a
   GitHub prerelease and an npm publish under the `next` dist-tag; for a
   final: the GitHub release, npm `latest` and the Homebrew tap PR>. npm
   versions can't be unpublished." Options: push it (Recommended), not yet.
4. Yes:
   `git tag -a "v$BUMP" -m "hgi $BUMP" "$SHA" && git push origin "refs/tags/v$BUMP"`.
   If the push is rejected, don't retry with other refs or `--force`: report
   the error (usually the role from Step 0, item 1).

## Step 6: Watch the release workflow

```bash
: harness-step '/release' 'watch the release workflow' --waiting 'release workflow for the pushed tag'
```

1. Find the run (Step 1's query; it can take a minute to appear). Report its
   URL.
2. Poll `gh run view <id> --repo HGInsights/hgi-cli --json status,conclusion,jobs`
   every 60 s, at most 90 minutes. Builds, smoke tests on four platforms and
   `brew install` take a while.
3. **Approval.** When the status is `waiting`, the `npm-publish` job (and for
   a final, `homebrew-pr`) is held by the `release` environment. Tell the
   operator to review and approve it at the run URL, and keep polling. Do
   not approve it yourself through the API.
4. Once `github-release` has succeeded, do Step 7 while you keep watching.
5. **A failed run.** Read the failing job's log
   (`gh run view <id> --log-failed`). Nothing was published if it failed
   before `npm-publish`; say which jobs ran. Don't re-run a job that
   publishes, and don't delete or move the tag: fix the cause in a PR and
   release the next rc (or, after a failed final, the next patch). The
   exception is a flaky build or smoke job before any publish, which
   `gh run rerun <id> --failed` may retry once, after telling the operator.
6. Succeeded: check npm with
   `npm view @hginsights/hgi dist-tags --json`. `next` (rc) or `latest`
   (final) is `$BUMP`.

## Step 7: Fix up the release notes

```bash
: harness-step '/release' 'release notes'
```

The workflow writes only the install and verification notes. Prepend what
changed:

1. `gh release view "v$BUMP" --repo HGInsights/hgi-cli --json body -q .body > /tmp/…`
   (a temp file outside the repository).
2. Above it, write:
   - If `skills/hgi/SKILL.md` changed since `PREV` (Step 3, item 5's check), a
     first line: "**The `hgi` agent skill changed in this release.** If you
     installed it with `hgi skill install`, run `hgi skill install --force`
     after upgrading." (`docs/releasing.md` step 6: an installed copy isn't
     updated otherwise.)
   - `## What's changed`: the grouped list from the bump PR, regenerated
     from `git log "$PREV".."v$BUMP"` so it is exact, without the
     `chore: release` commits.
3. `gh release edit "v$BUMP" --repo HGInsights/hgi-cli --notes-file …`.

## Step 8: After the rc, or after the final

```bash
: harness-step '/release' 'finish'
```

**After an rc:**

1. Tell the operator what to run on clean machines, from a checkout of the
   tag (only the scripts are used; it opens a browser to sign in):
   `bash scripts/verify-release.sh v$BUMP --route binary` and
   `--route npm`, once on macOS and once on Linux. Your own development
   machine isn't clean; don't run it here and call the release verified.
2. Ask (`[product]`, header `Final`): go on to the final `V` now, or wait for
   the clean-machine checks. Go on: Step 3 with `BUMP=V`. Wait: end the turn;
   `/release` picks up from Step 1 later.

**After the final:**

1. **The tap PR.**
   `gh pr list --repo HGInsights/homebrew-tap --state open --head "hgi-$V" --json number,url`.
   Compare every `sha256` in its `Formula/hgi.rb` (`gh pr diff`) against the
   release's `SHA256SUMS`
   (`gh release download "v$V" --repo HGInsights/hgi-cli -p SHA256SUMS -D <temp dir>`),
   and check every `url` points at `v$V`. Report the result line by line.
2. All match: ask (`[product]`, header `Tap PR`) whether to merge it now
   (Recommended) or leave it to the operator. A mismatch: don't merge; say
   which lines differ.
3. Tell the operator to run `scripts/verify-release.sh v$V --route brew`,
   `binary` and `npm` on a clean macOS and a clean Linux machine and keep the
   output with the release record (`docs/releasing.md` step 5).
4. If `.github/workflows/ci.yml` still has no `compat-previous-release` job,
   say that `docs/releasing.md` step 7 is still open.

## Final report

The version and tag, the release URL, the npm dist-tag, the tap PR (merged
or not), and what is left for a person: the deployment approval if it is
still waiting, the clean-machine checks, the tap merge.

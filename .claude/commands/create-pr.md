# Create PR

Open a pull request for the current branch, with a title that follows the
repo's convention and a body that reproduces the repo's PR template.

<!--
Seeded from HGInsights/claude-code-setup templates/ @ 8a96a28, placeholders
filled for hgi-cli. Keep the commentary: each warning records a production
failure, and trimming one puts it back.
-->

## Inputs

All optional.

- `$ARGUMENTS`: a title override, or an issue number.
- `base: <branch>`: the branch to diff against and open the PR into. Default
  `main`; a stacked PR names its parent branch.

## 1. Check the branch

```bash
: harness-step '/create-pr' 'create the PR'
```

(A no-op marker: under the AI harness a hook records the step; elsewhere it
does nothing.)

1. Never work on the base branch, and never push to it.
2. Commit everything first. `git status` (never `-uall`) must be clean.
3. In a worktree the branch is often named after the directory, not the work.
   Push it under a descriptive name so the PR head reads well:
   `git push -u origin HEAD:<type>/<topic>`.

## 2. Gather the changes

1. Run `git fetch origin <base>` on its own first.
2. Then, in parallel: `git log origin/<base>..HEAD --oneline`,
   `git diff origin/<base>...HEAD --stat`, and the full
   `git diff origin/<base>...HEAD` for the files you need.
3. **Always compare against `origin/<base>`, never a bare `<base>`.** A local
   base branch only moves when someone pulls it in the primary checkout, so in
   a worktree it is often several commits stale. Diffing against it describes
   commits that already landed as part of this PR.
4. Read ALL commits on the branch, not just the last one.

## 3. Read the linked issue

1. Find the issue number: `$ARGUMENTS`, the branch name (`*/issue-<N>-*`), or
   `Closes #<N>` in a commit message.
2. `gh issue view <N> --repo HGInsights/hgi-cli --json title,body,labels`.
3. If `dev/active/issue-<N>/context.md` exists, read its
   `## Implementation Summary` and its review sections: the body carries them
   (section 5).
4. No linked issue: say so, and write `N/A` in the template's issue-dependent
   sections.

## 4. Write the title

1. Follow the title convention in `## Repo specifics

| Key | Value |
| --- | --- |
| Repo | `HGInsights/hgi-cli` |
| Default base | `main`, or the `base:` input (stacked branches) |
| Merge method | squash only: the PR title becomes the commit on `main` |
| Title convention | conventional commits, as `main`'s history: `fix: …`, `feat(output): …`, `chore(deps): …` |

**No PR template** (`.github/pull_request_template.md` doesn't exist), so the
body is: `## Summary`, `## Linked issue` (`Closes #<N>`), `## Tests`, the review
record (section 5) and the review marker, then `## What I did not verify`.

**Before asking for review:** every PR needs an approving review from
`@HGInsights/maintainers` (code owners), with every review thread resolved, and
a push after an approval needs approval again. Say in the body what a reviewer
should look at first. A change under `packaging/`, `scripts/` or the build
config also states that the binary end-to-end suite ran (`CONTRIBUTING.md`).

**After the PR:** nothing.

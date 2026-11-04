# External waits: when someone other than the operator has to act

A session that can't go on until someone else acts (another team's review,
CI that another team owns, a dependency PR in another repo, a Jira ticket
another team moves) says so with one structured line per thing it waits on,
and then ends its turn. The harness watches those things and brings the
session back when they change.

<!--
Copied from the AI harness's own runbook: keep the line format exactly as
written here, since the harness parses it. Standalone on purpose,
like operator-questions.md.
-->

## When to use it

- Someone **other than the operator** has to act, on something outside your
  own PR, before the work can go on: a PR in another repo this work depends
  on (another team's review or merge), an issue another team owns, a ticket
  another team has to move or answer.
- You have done everything you can until then, and said what you did.

Not for:

- **A question for the operator.** That goes through `AskUserQuestion`
  (`.claude/skills/runbooks/operator-questions.md`), never through
  `WAITING-ON`. The operator is never a `WAITING-ON` ref.
- **Something you can wait for yourself in this turn**, such as your own CI
  run (watch it with a bounded loop instead).
- **Your own PR** (one opened under the operator's login, as `/create-pr`
  does), even when it waits on a reviewer outside the operator or a check
  another team owns: the harness's PR rules already bring the session back
  for a review, red CI or a rebase there, and a `WAITING-ON` line for it is
  ignored. Just finish the turn.

## The line

End the turn's final message with one line per thing you wait on:

```text
WAITING-ON: <ref> <what you need from them>
```

- The line starts with `WAITING-ON:` (leading spaces only: no list marker, no
  quote, no code fence).
- `<ref>` is the first word after it, exactly one of:
  - `https://github.com/<owner>/<repo>/pull/<n>`
  - `https://github.com/<owner>/<repo>/issues/<n>`
  - a Jira key, `[A-Z][A-Z0-9_]*-[0-9]+` (for example `OPS-1234`)

  Write it bare: no backticks, no angle brackets, no trailing period, no
  `#123` shorthand. A ref in any other form isn't understood.
- The rest of the line is one plain sentence saying what you need from them.
  It is optional, but write it: it is what the operator reads in the inbox
  (`Waiting on <ref> (<sentence>)`).
- One line per ref. Two parties, two lines, each with its own sentence.

Example, the last lines of a release session:

```text
The prod image bump is up for review; nothing else can go out until it merges.

WAITING-ON: https://github.com/example-org/infra/pull/812 The platform team to approve and merge the image bump.
WAITING-ON: OPS-1234 The platform team to confirm the maintenance window.
```

## What happens next

- The inbox shows the session as waiting on those refs, with links, and
  raises no alert: it isn't waiting on the operator. If no line has a valid
  ref, it shows as an ordinary waiting-on-you item with the note
  `WAITING-ON line not understood: <line>`, and alerts.
- The harness records each ref's state and watches it on every tick, with no
  LLM call (only on a harness account, while the reconciler runs with at
  least one `dispatch=on` repo; without it the wait just shows in the inbox): for a GitHub PR or issue, new comments and reviews by someone
  other than the operator, a merge, a close; for a Jira key, a status change
  or a new comment by someone else.
- On a change it stops the session and resumes it once, with a message
  naming who did what on which ref, the first 300 characters of the new
  comment or review, and "Continue. If you are still waiting, end with
  WAITING-ON again." Read the ref yourself before acting on it.
- **Still waiting after that?** End again with `WAITING-ON` lines. They are
  watched from that point on. Without them the session is treated as waiting
  on the operator.
- A ref the harness can't read for three ticks in a row comes back to the
  operator as one inbox item, with how to reach the session.
- The operator can attach and talk to the session at any time; once it is
  working again, the harness stops watching for it.

## Waiting inside the turn (a background watcher)

When you wait in the same turn instead, with a background task that polls
(for example a watcher on a review you requested), the turn hasn't ended, so
the lines above aren't read. Say what you wait on with a step marker before
you start waiting, as its own Bash call:

```bash
: harness-step '<command> <arg>' '<step>' --waiting 'review of https://github.com/example-org/infra/pull/812 from <reviewer>'
```

Add `--until <ISO-8601 UTC>` when the wait has a known end. While the marker
holds, the harness never flags the session as "may be stuck"; it shows it
under "Waiting on others" in the inbox, with a link for each GitHub PR or
issue URL and Jira key in the text and, for a PR, its requested reviewers.
The next marker clears it. With `--until`, it stops counting as a wait
`stuck_tool_mins` (`reconciler.conf`) after that time. A turn that ends with
`WAITING-ON` lines while background tasks still run is shown the same
way. Nothing is resumed for this kind of wait: the session's own
watcher brings it back.

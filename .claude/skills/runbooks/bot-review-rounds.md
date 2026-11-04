# Bot review rounds: handling one round of a bot's review on your PR

The harness hands a PR's session each round of a bot's review (Quorum,
Codex, Copilot) when every new finding is a bot's and the judge found it
worth acting on. Its prompt says `This is bot review round <N> of <limit>`.
This runbook is what to do with that round: take every finding, push, post
one round reply, and only then ask the operator what only they can decide.

<!--
Copied from the AI harness's own runbook. The harness's reconciler reads
the round reply's marker and lines into the inbox item it shows the operator
when the rounds stop. Keep the
marker and the three line forms exactly as written here.
-->

## Why

A bot that reviews after every push keeps a PR moving only while each round
ends in a push. The harness stops handing rounds off, and asks the operator
once, when the limit is reached, when the bot posts again with no new commit
since its last round, or when a finding comes back that an earlier round
already handled. The operator decides from the item that lists every round:
what the bot found, and your reply to it. A finding that asks to *confirm* a
product or architecture choice is the operator's decision, not yours: left
in the PR thread, they only learn about it when they open the PR.

## Per finding

Read the round's reviews, comments and inline threads (`gh pr view <P>
--repo <owner/name> --comments`, and the review threads). For each finding,
do exactly one of:

1. **Fix it** on this branch.
2. **Accept it with a reason**: you won't change the code, and you can say
   why in one sentence (it is wrong about the code, out of the PR's scope,
   below the review bar in `.claude/agents/code-reviewer.md`). Reply on the
   finding's thread with the reason, so the bot and the operator both see it.
3. **Ask**, when the finding asks to confirm that a behavior is intended
   ("confirm this is intended", "is this deliberate?", "please verify this
   change in behavior"):
   - a **product or architecture** choice (what users see, what fails or
     succeeds, a stricter or looser check, a contract between components):
     ask the operator through `.claude/skills/runbooks/operator-questions.md`:
     `AskUserQuestion` only, tagged `[product]` or `[architecture]`, one
     decision per question, answerable on its own: the PR number and title,
     the finding quoted in full, its file, what the code does now, and the
     options;
   - a **technical** choice: the `decision-consult` agent, as that runbook's
     Routing says. It reaches the operator only when you still disagree after
     2 exchanges.

Don't fix a "confirm" finding by guessing the answer, and don't accept one
on your own: either is the decision the operator didn't make.

## Order: push and reply first, then ask

The other fixes never wait for the questions:

1. Make every fix, run the checks the repo asks for, commit and push.
2. Post the round reply (below).
3. Then ask your questions (`AskUserQuestion`, `decision-consult`).
4. Act on each answer: a change gets its own commit and push, and a short
   PR comment saying what the operator decided. The round's reply stays as
   it was.

## The round reply

Once per round, post one PR comment as the PR's author, with
`gh pr comment <P> --repo <owner/name> --body-file <file>` (a file, so the
marker's characters reach GitHub as written). Its first line is the marker,
exactly:

```
<!-- harness-bot-round: n=<N> head=<sha> -->
```

`<N>` is the round number from the prompt; `<sha>` is the full
`git rev-parse HEAD` you pushed, or the PR's unchanged head when you pushed
nothing. Then one line per finding, in this form:

```
Fixed: <finding, a few words> (<short sha of the commit>)
Accepted: <finding>: <reason>
Asked you: <finding>
```

Example:

```
<!-- harness-bot-round: n=2 head=4f1c2a9e0b7d6c5a4f3e2d1c0b9a8f7e6d5c4b3a -->
Fixed: no test for the key rotation SQL (4f1c2a9)
Accepted: PR body names the wrong migration: it names the right one, the bot read an older revision
Asked you: decrypt now rejects credentials that aren't the v2 shape
```

The harness shows the first 10 lines of each round's reply in the operator's
item, so put the findings that need attention first. Post a new reply for a
round only to correct it: the newest one with that `n` is the one shown.

## Then end the turn

Finish the turn as the prompt asks (the post-PR review and CI gate, when it
names a `/fix-issue` run). The bot's next review brings the next round back
to you; nothing else to wait for.

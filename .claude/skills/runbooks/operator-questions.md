# Operator questions: the contract

Every question an SDLC command asks the user follows this contract:
`/task-to-github-issue`, `/fix-issue`, `/grill-me`, `/create-pr`, and anything
they call. It also decides which questions reach the user at all.

<!--
Seeded from HGInsights/claude-code-setup templates/ @ 8a96a28, placeholders
filled for hgi-cli. Keep the commentary: each warning records a production
failure, and trimming one puts it back.
-->

## Why

A question is often read away from the transcript that produced it: in a
notification, on a phone, in a queue of questions from several sessions, or by
a background session's hook that receives only the `AskUserQuestion` tool
input. The text the session wrote just before the question isn't there. So
the reader sees **the question and its options, and nothing else**. A question
that points at "item 4", "the stories above" or "the plan" can't be answered.

The user also shouldn't be asked what two models can settle between
themselves. Product decisions need a human. Architecture decisions change a
recorded design, so they need a human too. Technical details go to a second
model (the `decision-consult` agent) until the two agree.

## Rules

1. **Every question goes through `AskUserQuestion`.** Never end a turn with a
   plain-text question, even a yes/no one. A plain-text question in a
   background session is a session that stops with nobody asked, and no hook
   or notification ever sees it.
2. **The `question` text starts with exactly one tag**, `[product]`,
   `[architecture]` or `[technical]`, then a space. One tag only, never two,
   never none. See [Tags](#tags).
3. **It is answerable on its own.** The `question` text states:
   - what is being decided;
   - why it has come up now (which step, what was found);
   - for `[architecture]` and `[technical]`: Claude's and the second
     reviewer's positions and whether they agree (see [Routing](#routing)).

   Each option's `description` says what choosing it means for the user or the
   product, not just what it is. The recommended option comes first, and its
   `label` ends in ` (Recommended)`.
4. **Artifacts by absolute path.** Any file the question is about (a draft
   issue, a plan, a diff) is named by its **absolute path**. Build it from
   `git rev-parse --show-toplevel` and paste the literal result. A
   worktree-relative path like `dev/active/issue-9/plan.md` is ambiguous
   when several worktrees exist.
5. **Never refer to text the reader can't see.** Banned, unless the question
   itself contains what they point at:
   - "item 4", "point 2", "option A" (when A is defined outside the question);
   - "above", "below", "earlier", "as discussed", "as mentioned", "as before";
   - "these stories", "this approach", "the gaps", "the changes";
   - "the plan", "the issue", "the diff", "the draft" without its content or
     absolute path.
6. **One decision per question.** Up to 4 questions per `AskUserQuestion`
   call, each one standalone (the user may answer them one at a time). Never
   put several decisions in one question as a numbered list.

`AskUserQuestion` limits: `header` is at most 12 characters, each question has
2 to 4 options, and a `label` is 1 to 5 words. Put the substance in `question`
and in each option's `description`; keep the label short. The user can always
type a free-text answer instead of picking an option.

### Example

Bad (relies on surrounding text, no tag, several decisions):

```text
question: "Accept my defaults for items 1-4 above?"
options:  "Yes" / "No"
```

Good:

```text
question: "[product] ABC-31 asks for a 'fast' search endpoint but sets no
  target. This came up in the gap analysis for the GitHub issue I'm drafting
  from ABC-31, and the acceptance criteria need a number a test can check.
  Which latency target should the issue require?"
header:   "Latency"
options:
  - label: "p95 under 200ms (Recommended)"
    description: "Matches the other search endpoints. Users see results as
      they type; the issue gets a load test against that number."
  - label: "p95 under 1s"
    description: "Easier to hit with the current index. Typing feels laggy;
      fine for a back-office screen, poor for the main search box."
  - label: "No target for now"
    description: "Ships sooner, but 'fast' stays untestable and the reviewer
      can't reject a slow implementation."
```

## Tags

- **`[product]`**: what is built and for whom: scope, priority, UX, value,
  acceptance criteria, policy, or accepting a risk.
  - Whether an edge case (unknown input, empty result) is in scope, and what
    the user sees for it.
  - Approving drafted user stories and acceptance criteria.
  - One GitHub issue or several, and in which order they ship.
  - Accepting a known limitation, or creating a new repo label (repo policy).
- **`[architecture]`**: a choice that changes or adds to a decision recorded
  in `CONTRIBUTING.md` (Ground rules), `docs/security.md` and `docs/compatibility.md`: a new component, service or dependency, who owns which
  state, or an interface other parts rely on.
  - Adding a service, queue or database the design doesn't have.
  - Moving state from one owner to another.
  - Changing an API, event or file format that other parts consume.
  - Adding a runtime dependency (a new CLI, language runtime or library).
- **`[technical]`**: how to build something inside the design already decided:
  code structure, using a library the project already depends on, test
  approach, internal naming.
  - Splitting a module into functions, or which file a helper lives in.
  - Which idiom of the language or framework to use.
  - Whether a case is covered by a unit test or an integration test.
  - Naming an internal variable or a temp directory.

**Tie-break:** when unsure between two tags, use the one that reaches the
user. Between `[technical]` and either other tag, pick the other tag. Between
`[product]` and `[architecture]`, both reach the user; pick the one that
describes the decision better.

## Routing

| Tag | Consult first? | Reaches the user? |
| --- | --- | --- |
| `[product]` | no | always, unless it qualifies as an assumed default (below) |
| `[architecture]` | yes, 1 exchange | always, showing both positions and whether they agree |
| `[technical]` | yes, up to 2 exchanges | only if the two still disagree after 2 exchanges; then shows both positions |

The consult is the `decision-consult` agent
(`.claude/agents/decision-consult.md`): the external reviewer CLI, or an
in-model opinion when it is unavailable. Spawn it with everything it needs
inlined: the question, the options, your recommendation and reasoning, and the
relevant context (file excerpts, the plan section). It never reads files or
computes context itself. It returns:

```text
AGREE: true|false
REVIEWER: external (codex <name>)|external|in-model (<reason>)
POSITION: <option label>
REASONING: <1-5 sentences>
```

An **exchange** is one Claude position plus one consult response.

**`[product]`**: ask the user directly. No consult. Exception: an assumed
default (next section).

### Assumed defaults

Every question costs the user a context switch. A `[product]` decision is
**not asked** when all of these hold:

- the stakes are low: it changes no cost, security or permission policy, data
  handling, or scope boundary (what is in or out of the work);
- it is easy to reverse after the issue or PR exists;
- one option is clearly right, and you'd recommend it without hesitation.

Take your recommendation, record it at once in the same place and format as
other decisions ([Recording](#recording-decisions)), ending in
`decided by: default`, and list every default under **"Assumed defaults
(change any)"** in the next sign-off question the user sees: Gate B for
`/task-to-github-issue`, plan approval for `/fix-issue` (or the PR body when
`/fix-issue` skips plan approval), the synthesis for `/grill-me`. The user
changes any of them there in free text; update its recorded line to the new
choice and `decided by: user` before going on.

When in doubt, ask: a wrong default that ships costs more than one question.
`[architecture]` and `[technical]` decisions are never defaults; they follow
the routing above.

(Without this rule, the first run of the gated issue flow asked 8 questions in
4 rounds before sign-off, including a yes/no on a notification detail and a
"proceed?" that only replayed answers just given.)

**`[architecture]`**: run the consult once, then always ask the user, whatever
it says. The question text states Claude's position, the second reviewer's
position, and whether they agree. Each option's `description` says who favors
it. Name the second reviewer by what actually ran: the external reviewer when
the consult says `REVIEWER: external`; when it says `in-model`, "the in-model
reviewer", and the question says the external reviewer was unavailable. Never
present an in-model opinion as the external one's. Agreement never settles an
architecture decision; the user does.

**`[technical]`**:

1. Exchange 1: run the consult with your position.
   - `AGREE: true`: settled. Record it (below) and don't ask.
   - `AGREE: false`: either adopt the consult's position (settled; record it
     with the consult's position as the choice) or rebut it once.
2. Exchange 2: run the consult again, inlining exchange 1 (its `POSITION` and
   `REASONING`) and your rebuttal.
   - `AGREE: true`: settled. Record it.
   - `AGREE: false`: stop. Ask the user one `[technical]` question. The
     question text says the consult ran 2 exchanges without agreeing and
     names the reviewer. Option 1 is Claude's position, label ending in
     ` (Recommended)`, description starting "Claude:" with its reasoning.
     Option 2 is the consult's position, description starting "Reviewer:"
     with its reasoning.

**When the consult answers `POSITION: NONE`** (not `NONE OF THESE:`), it
didn't give an opinion: a required input field was missing, or the decision is
really a product decision. That is not a disagreement and doesn't count as an
exchange. Fix the input and run it again, or, if its `REASONING` says it is a
product decision and you agree, re-tag it `[product]` and handle it like any
product decision.

**When the consult answers `NONE OF THESE: <alternative>`**, it disagrees with
every option. For `[technical]`, treat it as `AGREE: false`: adopt the
alternative (settled; record it) or rebut, and if exchange 2 still disagrees,
the alternative is the consult's option in the user question. For
`[architecture]`, add the alternative as its own option, described as the
consult's; if that would make 5 options, drop the option neither side favors.

**An external-reviewer outage alone never interrupts the user.** The consult
falls back to an in-model opinion and says `REVIEWER: in-model`. The routing
is unchanged; the decision is recorded as `second reviewer: in-model`, and the
next sign-off shows it.

## Recording decisions

Every decision is written down, one line each, whether the consult settled it,
the user answered it, or it was taken as a default:

```text
- <the question, standalone> → <the choice>. <one line of reasoning>. second reviewer: external
- <the question, standalone> → <the choice>. <one line of reasoning>. decided by: user
- <the question, standalone> → <the choice>. <one line of reasoning>. decided by: default
```

For architecture, add both positions and whether they agreed.

**Write each line to disk as soon as the decision is made**, before the next
question or consult. A session can crash or be compacted at any point; a
decision held only in the conversation is lost. When a session resumes, it
re-reads the file first and doesn't consult or ask again about anything
already in it.

Where:

- **`/task-to-github-issue`**: `dev/active/<TASK-KEY>/decisions.md` (or
  `dev/active/<slug>/decisions.md` with no tracker key). At Gate B the
  technical lines are copied into the draft's `## Technical Notes` →
  `### Decisions settled with the second reviewer`, so they land in the issue.
- **`/fix-issue`**: `dev/active/issue-<N>/context.md` → `## Decisions`
  (create the file with that section if the dev docs don't exist yet). The
  plan's `## Decisions` section repeats them, and so does the plan-approval
  question.
- **`/grill-me`**: `dev/active/<topic>/decisions.md`, then the
  synthesis.

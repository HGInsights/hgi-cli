Interview me relentlessly about a plan, design, or idea until we reach
shared understanding. Topic: $ARGUMENTS (ask if empty).

<!--
Seeded from HGInsights/claude-code-setup templates/ @ 8a96a28, placeholders
filled for hgi-cli. Keep the commentary: each warning records a production
failure, and trimming one puts it back.
-->

Step 1: Get a detailed description: the problem, solutions considered,
        known constraints, what they're unsure about. When you have to ask
        for it (or for the topic), ask a `[product]` question per
        `.claude/skills/runbooks/operator-questions.md` with the options
        "I'll describe it below (Recommended)" (the user types into the
        free-text answer) and "Stop for now".
        Run first: `: harness-step '/grill-me' 'get a description'`

Step 2: Explore the codebase and `CONTRIBUTING.md` (Ground rules), `docs/security.md` and `docs/compatibility.md` FIRST. Never ask the user
        something the code or the docs already answer. Verify claims about
        current state, find existing patterns, identify constraints they
        didn't mention. Delegate broad exploration to an `Explore` subagent
        on Haiku.
        Run first: `: harness-step '/grill-me' 'explore the code first'`

Step 3: Systematic interrogation. Every question follows
        `.claude/skills/runbooks/operator-questions.md`: asked with
        `AskUserQuestion` (never a plain-text question), starting with one
        tag (`[product]`, `[architecture]`, `[technical]`), answerable on its
        own (it names the topic and gives artifacts by absolute path), one
        decision per question. Route by tag:
  - `[product]`: ask the user, unless it qualifies as an assumed default
    (`operator-questions.md` → Assumed defaults); list those in Step 4
  - `[architecture]`: run the `decision-consult` agent once, then ask the
    user, showing both positions and whether they agree
  - `[technical]`: run `decision-consult` instead of asking; only a
    disagreement that survives 2 exchanges reaches the user
  - Write each decision to `dev/active/<topic>/decisions.md` as soon as
    it is made (consult-settled, answered, or taken as a default); a resumed
    session re-reads it and doesn't re-ask anything in it
  For each topic area:
  - Ask ONE question at a time; never dump a batch
  - Provide a recommended answer with each question, as the first option,
    labeled "(Recommended)"
  - Resolve dependencies first (nail down A before asking about B)
  - Challenge assumptions; play devil's advocate even on reasonable answers
  - Be specific: "How will you handle X?" beats "What about error handling?"

  Cover: problem framing, solution alternatives and what was ruled out,
  architecture fit and failure modes, explicit scope boundaries, edge cases
  and rollback, validation and success metrics, sequencing and blockers.
  Run first: `: harness-step '/grill-me' 'interrogation'`

Step 4: Synthesize: shared understanding, decisions and rationale,
        remaining risks, next steps. List "Assumed defaults (change any)".
        Include "Decisions settled with the second reviewer": one line per
        technical decision the consult settled, each ending in
        `second reviewer: external` or `second reviewer: in-model`
        (`operator-questions.md` → Recording decisions).
        Then ask one `[product]` `AskUserQuestion` per the contract. The
        synthesis text may not be visible where the question is read, so the
        question itself carries the "Assumed defaults (change any)" list (or
        "none") and the one-line decisions. Options: "Write it to plan.md
        (Recommended)" (saved to `dev/active/<topic>/plan.md`) and
        "Change something first" (the user types which default or decision
        to change; update its line in `decisions.md` to `decided by: user`
        and ask again).
        Run first: `: harness-step '/grill-me' 'synthesize'`

Step markers: at the start of each step, run its marker line as one Bash
call of its own. `:` is the shell no-op; under the AI harness a hook records
the step, elsewhere it does nothing.

Rules:
- Always recommend; never just ask "What do you think?"
- Never end a turn with a plain-text question; use `AskUserQuestion`
- Read the code before asking
- Know when to stop: consistent, specific, confident answers means done

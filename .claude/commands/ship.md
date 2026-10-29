---
description: Build, gate, review, triage and fix one Saku task autonomously; report once at the end
argument-hint: <what to build or change>
---

Task: $ARGUMENTS

Follow "Agents (the main session orchestrates)" in CLAUDE.md:

1. Read the current stage file and the requirement sections the task touches. If the task
   conflicts with the requirements, stop and ask.
2. Classify the tier from the change itself; log it with a one-line reason.
3. Write the spec in `.agent-runs/<date>-<slug>/spec.md` from `docs/spec-template.md`.
4. Build chunk by chunk with `builder` or `builder-heavy`.
5. Gates: CHECKS; the page crawler for Tier 1 and 2 UI (from D1).
6. Run only the tier's reviewers, in parallel, each with only its allowed inputs.
7. Triage, fix in one batch, re-check; re-review only Tier 2 logic fixes; at most 2 rounds.
8. Commit (files by name, never `git add -A`; the owner pushes), update the run log, the ledger
   and `plugins/ops/actions.md`.

Do not message me until done, except for a stop condition. Finish with the report format from
CLAUDE.md and nothing else.

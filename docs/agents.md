# Agent profile

Read by the shared agents (the `selfhost-blueprint` repo's `claude/agents`, linked into
`~/.claude`) and by the orchestrator. The loop and tiers are the shared `/ship`
(`~/.claude/commands/ship.md`); the report format is in `CLAUDE.md`.

## The app

Saku is a rule-based investing assistant: it collects raw market data from several sources,
checks it, runs strategies and backtests, and keeps tamper-evident forward records of what it
signaled. The worst failure is acting on wrong data or a wrong calculation; a forward record,
once written, cannot be corrected (only annotated).

## Rules files

- Public: `CLAUDE.md`, all of it (the data, numerics, integrity and agnostic-core rules never
  break).
- Private: `plugins/ops/claude-rules.md` (read it if it exists).

## Risk class

A (silent and lasting): forward records are hash-chained and never corrected, and signals, money
and tax are acted on.

## Trust territory (Tier 2)

Areas: data pipeline, checks and data health, engine and indicators, backtests, forward records
and the hash chain, alerts about signals, money, tax, auth and authorization, migrations, secrets
handling; any new page.

Paths (a changed file here makes the change Tier 2):
- `packages/core/`, `packages/reference/`, `packages/data/`, `packages/db/`, `packages/auth/`
- `packages/plugin-sdk/src/` except `cli/` files that only change wording or argument parsing
- `plugins-public/src/`, `plugins/` code (not `plugins/ops/`)
- `ops/update-server.sh`, `ops/ci-status.sh`, `ops/systemd/`
- any app page or server route (from D1)

## Domain checklist

- No look-ahead: anything read before it was known; rates, FX and index values only through
  `asOf`.
- Unknown values never turned into 0 or a guess; a doubtful data state never gives a normal or
  confident result; red data applies the strategy's safe state.
- Stored data never overwritten without the revision log; forward records append-only and
  hash-chained; checks never loosened, tolerances never tuned.
- float64 for analytics, decimal.js for money, tax and quotas; money carries its currency.
- Near-ties (within 1e-9 relative) keep the previous state.
- Fault cases for every new data path.

## Owner decides

A closed list; anything else the orchestrator decides and reports. What a signal means, how money
or risk is shown, which data is trusted (when the requirements do not decide), requirement
changes, tax rules the owner's cases do not settle.

## Standing rules

Confirmed by the owner 2026-11-04.

- 2026-10-29: reviewer findings: fix what is right, take the recommended option on cosmetic
  asks, skip what is wrong; ideas that fit the current stage are built, others go to
  `docs/backlog.md`.
- 2026-11-01: admin-only operational alerts (about the server and the runs, never data or
  signals) may go out before the A1 gate.

## Texts and time

- User-facing text: `packages/content` (`en.json` base, `ja.json` for the owner's install).
- Trading dates in America/New_York as `YYYY-MM-DD`; display in the install's time zone.

## CHECKS

`pnpm check:all`

## Models and efforts

The orchestrator passes these values as `model` and `effort` when it starts each agent.

| Role | Model | Effort | Note |
|---|---|---|---|
| builder | sonnet | medium | |
| builder-heavy | opus | high | chained records and money: mistakes cannot be recomputed away |
| code-reviewer-light | sonnet | medium | |
| code-reviewer | opus | high | accepted findings in nearly every run so far |
| Tier 3: builder-heavy, code-reviewer | opus | xhigh | plan, build, normal and adversarial review |
| ux-reviewer | sonnet | medium | Tier 1 and 2 UI, from D1 |
| trust-reviewer | sonnet | medium | Tier 2 UI, from D1 |
| triage | opus | medium | when two or more reviewers ran |
| summarizer | haiku | low | |

## Reviews used

- Tier 0: none. Tier 1: code-reviewer-light (+ ux-reviewer if UI, from D1). Tier 2:
  code-reviewer (+ ux-reviewer and trust-reviewer if UI, from D1). Tier 3: code-reviewer on the
  plan, then code-reviewer normal and adversarial, triage.
- Page crawler for screenshots: from D1 (phone, wide, dark; Japanese too when translated).

## Paths

- Spec template: `docs/spec-template.md`.
- Run logs: `.agent-runs/<date>-<slug>/` (git-ignored).
- Ledgers: `plugins/ops/agent-ledger.csv` (per reviewer run), `plugins/ops/run-ledger.csv` (per
  task, from 2026-11-03).
- Owner's actions: `plugins/ops/actions.md` (done items and the work log in `actions-done.md`).

## Setup changes

- 2026-11-03: risk class A recorded; Tier 3 row added (`xhigh`); run ledger started.

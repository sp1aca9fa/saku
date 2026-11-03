# Agent profile

Read by the shared agents (the `selfhost-blueprint` repo's `claude/agents`, linked into
`~/.claude`) and by the orchestrator. The loop, tiers and report format are in `CLAUDE.md`
("Agents").

## The app

Saku is a rule-based investing assistant: it collects raw market data from several sources,
checks it, runs strategies and backtests, and keeps tamper-evident forward records of what it
signaled. The worst failure is acting on wrong data or a wrong calculation; a forward record,
once written, cannot be corrected (only annotated).

## Rules files

- Public: `CLAUDE.md`, all of it (the data, numerics, integrity and agnostic-core rules never
  break).
- Private: `plugins/ops/claude-rules.md` (read it if it exists).

## Trust territory (Tier 2)

Data pipeline, checks and data health, engine and indicators, backtests, forward records and the
hash chain, alerts about signals, money, tax, auth and authorization, migrations, secrets
handling; any new page.

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

What a signal means, how money or risk is shown, which data is trusted (when the requirements do
not decide), requirement changes, new dependencies, services or costs.

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
| ux-reviewer | sonnet | medium | Tier 1 and 2 UI, from D1 |
| trust-reviewer | sonnet | medium | Tier 2 UI, from D1 |
| triage | opus | medium | when two or more reviewers ran |
| summarizer | haiku | low | |

## Reviews used

- Tier 0: none. Tier 1: code-reviewer-light (+ ux-reviewer if UI, from D1). Tier 2:
  code-reviewer (+ ux-reviewer and trust-reviewer if UI, from D1).
- Page crawler for screenshots: from D1 (phone, wide, dark; Japanese too when translated).

## Paths

- Spec template: `docs/spec-template.md`.
- Run logs: `.agent-runs/<date>-<slug>/` (git-ignored).
- Ledger: `plugins/ops/agent-ledger.csv`.
- Owner's actions: `plugins/ops/actions.md` (done items and the work log in `actions-done.md`).

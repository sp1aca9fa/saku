# CLAUDE.md (Saku)

## Reading protocol (follow every session)
1. Read `docs/requirements/00-index.md` (its Status table names the current stage).
2. Read the current stage file in `docs/requirements/stages/` (ask if the current stage is unclear).
3. Read only the area files that stage file lists as relevant to the task, and the relevant sections of `docs/system-design.md`.
4. Read the full `REQUIREMENTS.md` only for the **completion check** at the end of a stage, or when the owner asks.

If a request conflicts with the requirements, point out the conflict and ask before proceeding.

## Pillars (priority order, use them for trade-offs)
1. Reliability: never act on wrong data or wrong calculations.
2. Evidence: research-backed, overfitting-aware, judged on tamper-evident forward results.
3. Decision clarity: trade-offs in the base currency and ranges, everywhere.
4. Accessibility: professional methods usable without understanding the math.
5. Honesty and protection: show uncertainty and luck; never oversell.

## Working rules
- Work stage by stage. Nothing beyond A1 goes live until its gate passes (A2 development during A1's window is allowed, see stage-a).
- Only the current stage is detailed. If a later-stage detail is unclear, ask; don't invent.
- Don't implement unrequested features; put ideas in `docs/backlog.md` and mention them.
- Small changes: one feature or fix per branch/PR, with tests.
- Ask before adding a dependency (MIT, Apache 2.0, BSD, ISC only; never GPL/AGPL/LGPL), an external service, or anything that could cost money.
- Never commit API keys, `.env` files or market data to the public repo. Real recorded responses go only in the private `plugins/` submodule.
- Requirement changes: edit the split files in `docs/requirements/`, run `pnpm docs:build`, add a `14-decisions-log.md` entry. Never edit `REQUIREMENTS.md` directly.
- Unsure about a provider's limits or terms: check current docs and record findings in `docs/data-spike.md` or `docs/data-pipeline.md`.
- The app makes no LLM/AI API calls.

## Agnostic core (mandatory)
- Nothing particular to one country, provider, broker, language or person is hardcoded in core. It is a plug-in (`docs/requirements/15-plugins.md`) or an admin setting.
- Public plug-ins use official APIs; unofficial, scraped or personal ones go in the private `plugins/` submodule. Public examples and tests use neutral made-up names.
- Plug-ins never call `fetch` directly (use the SDK's HTTP client) and never write to the database.

## Language (mandatory)
Every user-facing string goes through `packages/content` (next-intl); `en.json` is the base, other language files may be partial. No hardcoded user-facing text, including in plug-ins. Code, comments, database values, docs and commits in US English.

## Data rules (never break)
- Import only raw data; never import indicators or derived series. Provider adjusted values and issuer data are for verification only.
- Yellow: compute with a visible warning. Red: never present a normal signal; apply the strategy's declared safe state and give exact instructions.
- Never silently overwrite stored data; use the revision log.
- Never disable or loosen a check to make a run pass; report the failure.
- Fault injection must detect 100% of material faults (all sources available); single-source days are never green; new data paths need fault cases.
- Rates, FX and index values are read only through `asOf` (no look-ahead).
- Data-health status appears wherever a signal is shown.

## Execution and numerics
- Default execution is next-day (`next_open`). `same_close` only for testfol parity tests, labeled as not achievable.
- float64 for analytics; decimal.js for money, tax and quotas; money always carries its currency.
- Near-ties (within 1e-9 relative) keep the previous state, in both core and reference.
- Trading dates in America/New_York as `YYYY-MM-DD`; display in the install's time zone.

## Reference implementation
`packages/reference` (core math only, not tax) never imports from `packages/core`. If they disagree, find the root cause; never copy one into the other. External golden values (testfol, TradingView, owner's tax cases) take precedence.

## Integrity rules (never break)
- Drafts create no forward record. Registered versions and library strategies are immutable.
- Forward records are append-only and hash-chained over RFC 8785 canonical JSON (the hashed text is stored); they store what was actually signaled (including safe-state days). Recomputations are annotations, never edits.
- The finder uses only post-registration forward data as its sanity check; no look-ahead.
- The robustness formula is approved before validation; validation is run once on held-out data and recorded whatever the result. Never iterate until it passes.
- Never tune defaults, weights, tolerances or strategies to hit targets or make results look better. Report honestly; targets change only at target reviews.
- Every library strategy cites its research basis.

## UX rules
- A UI feature is done only when tooltips, help text, glossary entries and decision-card text exist in `en.json` and in the owner's install languages (EN, JA).
- Every strategy display has a decision card and the full metric set; outcomes as ranges and base-currency amounts.
- Risks shown before a risky setting takes effect. No profiling questionnaires.
- No sign-up page. Every user-owned table has `owner_id`; every query on it is scoped to the signed-in user, and authorization is checked in every server action and route (never only in middleware). Market data stays global.

## Compute, jobs and MCP
- Heavy computation runs in server jobs or the browser (Web Workers), never in a web request.
- Jobs and plug-ins run only on the server; they refuse to run when `VERCEL` or `CI` is set. Idempotent, catch up on all unprocessed trading days, respect quotas, heartbeat only on full success.
- MCP level 1 is read-only (reads the analysis copy; no writes, no notifications); compact responses (< 20,000 characters) including data-health status; `noAi` sources' raw data left out.
- Migrations are add-only (drop in a later migration).

## Testing
- External golden values first; core vs reference comparison; incremental vs full (≤ 1e-9); fault injection; chain verification; wrong-user authorization tests; synthetic fixtures in the public repo; no live calls in tests. Real-data suites run on the server (`pnpm verify`).
- CI gates: lint, typecheck, tests, build, `pnpm docs:check`, tooltip and metric coverage; language coverage from D1.

## Communication
After each task: what changed, how it was tested, what's left, backlog ideas. Flag every assumption about trading, statistics, data or tax explicitly, and state tax assumptions precisely.

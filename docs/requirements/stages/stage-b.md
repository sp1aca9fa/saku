# Stage B: Evidence engine (Evidence)

Read for this stage: 05-strategy-model.md, 06-indicators.md, 09-analytics.md, 13-testing.md, 07-accounts-tax.md (tax hooks), 04-data-pipeline.md (layer E, fail-closed), `docs/evidence/backtests.md`.

## B1. Engine, backtester, reference implementation
- Full strategy model: indicators v1, signals (tolerance, delay, ensembles), chains, ranked blocks, exposure scaling, circuit breaker, synthetic leverage, USD and base-currency cash, costs, execution models, whole-share option, tax hooks (`TaxRegime` contract drafted).
- Reference implementation of the core math, written in a separate session that never reads `packages/core`.
- External golden values; testfol parity (same_close).
- **TR1:** re-run the evidence with next-day execution, costs and estimated tax in yen (owner's install); report median and share of 5-year windows.

## B2. Daily evaluation, library, forward records
- Evaluate all registered strategies daily (fail-closed, safe state); hash-chained forward records.
- Seed the library (10-15 families, owner approves `docs/strategy-library.md` first).

## B3. Robustness lab and statistics
- Parameter sweeps, walk-forward, block bootstrap, crisis replays; robustness score (formula approved first, pre-registered validation); deflated Sharpe and probability of backtest overfitting; Monte Carlo goal projection; regime history for the context pack.

> **Completion check:** when Stage B is believed done, read the full `REQUIREMENTS.md`, confirm every Stage B item and relevant requirement, list gaps, then run the stage review.


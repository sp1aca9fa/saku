# 13. Testing and parity

- Vitest (unit, integration), fast-check (property tests), Playwright (E2E).
- **External golden values first:** testfol parity, TradingView-verified indicator values, owner hand-computed tax cases. These catch spec misreadings that two Claude-written implementations would share.
- Core vs reference implementation (core math only) in CI, with near-tie handling (06).
- Incremental vs full recomputation (≤ 1e-9).
- Fault-injection suite (material faults), robustness score known-answer tests, chain verification tests.
- Adapters tested on recorded responses; no live calls in CI.
- CI gates: lint, typecheck, tests, build, `REQUIREMENTS.md` up to date, tooltip and metric coverage; translation coverage from D1.

## testfol parity
- Fixtures in `fixtures/testfol/<case>/`: YAML, date range, stats, daily equity CSV if available.
- Use SPY (not SPYSIM), start after 1993-02-01, `execution: same_close` (testfol's timing).
- Tolerances: CAGR ± 0.3pp, max drawdown ± 1.0pp, switches ± 5%. Differences documented in `docs/parity.md`.


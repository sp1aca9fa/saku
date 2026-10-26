# 13. Testing and parity

- Vitest (unit, integration), fast-check (property tests), Playwright (E2E).
- **External golden values first:** testfol parity, TradingView-verified indicator values, owner hand-computed tax cases (and the template regime's own cases). These catch spec misreadings that two Claude-written implementations would share.
- Core vs reference implementation (core math only) with near-tie handling (06).
- Incremental vs full recomputation (≤ 1e-9).
- Fault-injection suite (material faults), robustness score known-answer tests, chain verification tests, authorization tests (every server action called as the wrong user).
- No live calls in tests.

## Fixtures and where tests run
| Data | Where it lives | Runs |
|---|---|---|
| Synthetic bars and provider responses in each provider's exact shape | Public repo (`fixtures/`, plug-in tests, the templates) | `pnpm check:all` and GitHub Actions CI on every push |
| Real recorded provider responses | Private submodule (`plugins/test/fixtures`) | Locally and on the server when the submodule is present |
| Real market data (full history) | The server's database | `pnpm verify` on the server, weekly: testfol parity, core vs reference, incremental vs full, layer checks over full history. Results stored and shown on the admin page; a failure alerts admins. |

Market data and testfol daily equity curves are never committed to the public repo; testfol summary stats may be.

- CI gates (GitHub Actions on the public repo, synthetic data only, no secrets): lint, typecheck, tests, build, `REQUIREMENTS.md` up to date (`pnpm docs:check`), tooltip and metric coverage; language coverage from D1.

## testfol parity
- Fixtures in `plugins/test/testfol/<case>/` (private, real data): YAML, date range, stats, daily equity CSV if available. Summary stats may also be kept in the public `docs/parity.md`.
- Use SPY (not SPYSIM), start after 1993-02-01, `execution: same_close` (testfol's timing).
- Tolerances: CAGR ± 0.3pp, max drawdown ± 1.0pp, switches ± 5%. Differences documented in `docs/parity.md`.


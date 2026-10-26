# Stage A: Trust foundation (Reliability)

Read for this stage: 04-data-pipeline.md, 15-plugins.md, 03-assets.md, 05-strategy-model.md (execution, safe state, registration), 06-indicators.md (numeric rules), 11-alerts.md, 12-architecture-stack.md, 13-testing.md, `docs/system-design.md`.

## A1. Data spike (gate)
- Monorepo skeleton (12), CI, `pnpm check:all`, `pnpm docs:build`; `packages/db` with Stage A migrations on SQLite; `packages/auth` and `pnpm user create` (sign-in UI can wait for D1, the CLI and tables cannot); `packages/plugin-sdk` with the A1 contracts, the HTTP client and the jobs CLI; the `BarSource` template with a passing test.
- Plug-ins: Tiingo, Alpaca, Massive (public); Yahoo (private); FRED and ECB (public). Bootstrap Tier 0 from every bar source; FRED and ECB series; try issuer data per Tier 0 ETF (record availability, not a gate).
- Read each provider's current limits and terms and record them in `docs/data-spike.md`: personal-use conditions, and whether data may be given to AI models (sets `noAi`).
- Compute our adjusted series; run layers A-C over full history.
- Measure when each bar source's daily data is final after the US close (sets the daily run time).
- Server setup on the owner's machine: systemd units, state folders, backups, healthchecks.io, self-update script (12; the app's build and restart steps join with the app).
- Daily runs from the server over **20 trading days**; record each secondary source's availability per day (a day counts if any run that day got data; a library break counts as unavailable).
- Deliverables: `docs/data-spike.md`, first `docs/data-pipeline.md`, the chosen secondary sources and their roles.
- **Gate** (pre-registered, not changed after data is seen): the primary succeeds on every trading day (after retries); at least one secondary available on ≥ 95% of days; layer B passes on ≥ 99% of days where a secondary was available; layer C passes on ≥ 99% of days; every failure explained.

## A2. Thin slice (forward records start)
- Development may start during A1's observation window on synthetic or stored data, with no registration, no forward records and no production alerts. It goes live only after the A1 gate passes.
- Universe: SPY, SSO, UPRO, cash. One registered strategy (the owner's Setup 1 with ensemble trend signal, next-day execution, safe state) plus SPY buy and hold as benchmark.
- Minimal engine for the indicators this strategy needs; layers A-C; severity rules including the stand-in rule (04); safe state; alerts to admins and per-user channels (state change, data health, job failure; texts through the content package).
- Registration, append-only forward record, hash chain over RFC 8785 canonical JSON (the hashed text stored as is), daily RFC 3161 timestamps.
- CLI journal entry (done / skipped / delayed).
- Acceptance: runs unattended on every trading day for 2 weeks; a simulated red day produces the safe-state alert; chain verification passes.
- Later engine changes must reproduce this strategy's recorded signals or annotate differences; recorded entries are never edited.

## A3. Hardened pipeline
- Full Tier 0; revision log; weekly refetch and diff; quota guard; CSV fallback; layer D best effort (`IssuerSource`); data-health CLI report; `pnpm verify` on the server.
- Fault-injection suite (material faults) in CI.
- Acceptance: injected faults produce yellow/red as specified and never a normal signal on red; a broken run triggers the heartbeat alert.

> **Completion check:** when Stage A is believed done, read the full `REQUIREMENTS.md`, confirm every Stage A item and relevant requirement is met and consistent, list gaps, then run the stage review (02).


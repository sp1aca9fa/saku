# Stage A: Trust foundation (Reliability)

Read for this stage: 04-data-pipeline.md, 03-assets.md, 05-strategy-model.md (execution, safe state, registration), 06-indicators.md (numeric rules), 11-alerts.md, 12-architecture-stack.md, 13-testing.md, `docs/system-design.md`.

## A1. Data spike (gate)
- Monorepo skeleton, CI, Supabase project (Tokyo), Stage A migrations, `pnpm docs:build`.
- Bootstrap Tier 0 from Tiingo and Yahoo; FRED and ECB series; try issuer data per Tier 0 ETF (record availability, not a gate).
- Compute our adjusted series; run layers A-C over full history.
- Measure when Tiingo and Yahoo daily data is final after the US close (sets the schedule).
- Daily fetch from GitHub Actions over ≥ 10 calendar days (≥ 8 trading days); confirm Supabase stays active; record Yahoo availability from cloud IPs.
- Deliverables: `docs/data-spike.md`, first `docs/data-pipeline.md`.
- **Gate:** Tiingo succeeds on every run; layer B passes on ≥ 99% of days where Yahoo was available; layer C passes on ≥ 99% of days; every failure explained.

## A2. Thin slice (forward records start)
- Universe: SPY, SSO, UPRO, cash. One registered strategy (owner's Setup 1 with ensemble trend signal, next-day execution, safe state) plus SPY buy and hold as benchmark.
- Minimal engine for the indicators this strategy needs; layers A-C; severity rules; safe state; Discord alerts (state change, data health, job failure; EN/JA strings via the content package).
- Registration, append-only forward record, hash chain with external timestamping.
- CLI journal entry (done / skipped / delayed).
- Acceptance: runs unattended on every trading day for 2 weeks; a simulated red day produces the safe-state alert; chain verification passes.
- Later engine changes must reproduce this strategy's recorded signals or annotate differences; recorded entries are never edited.

## A3. Hardened pipeline
- Full Tier 0; revision log; weekly refetch and diff; retry run; quota guard; CSV fallback; keep-alive; heartbeat; layer D best effort; data-health CLI report.
- Fault-injection suite (material faults) in CI.
- Acceptance: injected faults produce yellow/red as specified and never a normal signal on red; a broken run triggers the heartbeat alert.

> **Completion check:** when Stage A is believed done, read the full `REQUIREMENTS.md`, confirm every Stage A item and relevant requirement is met and consistent, list gaps, then run the stage review (02).


# Pre-build issues (2026-10-26)

Review of `REQUIREMENTS.md` v0.7, `system-design.md` v0.3 and `CLAUDE.md` for issues that would break the build or force a rework later. Nothing here argues against the plan. Most items are small decisions that must be made **before the schema or the first forward entry exists**, because those become hard or impossible to change afterwards.

Temporary file. Once each item is decided, fold the outcome into the split requirement files (plus a `14-decisions-log.md` entry) and delete this file.

Legend: **Fix** = mechanical, no decision needed. **Decide** = owner decision, proposal given.

---

## Group 1: before the first-run task (minutes)

### 1. No git repository (Fix)
First-run step 4 commits, CI and scheduled jobs need GitHub. The folder is not a git repo.
**Proposal:** `git init`; `.gitignore` with `node_modules/`, `.env*`, `*:Zone.Identifier`, any local data/cache folder. Create the GitHub repo as **public** before A1 (Actions minutes are unlimited for public repos; the A1 daily runs need it).

### 2. Windows `Zone.Identifier` files (Fix)
`*:Zone.Identifier` files were copied from a Windows download. They would be committed.
**Proposal:** delete them and ignore the pattern (item 1).

### 3. `system-design.md` is in the wrong place (Fix)
Every reference (CLAUDE.md, index, stage files, layout) says `docs/system-design.md`; the file is at the repo root. The first-run split does not move it.
**Proposal:** move it to `docs/system-design.md` as part of the first-run commit. It is not part of `REQUIREMENTS.md`, so the byte-identical check is unaffected.

### 4. Living docs are inside the generated `REQUIREMENTS.md` (Decide)
`docs/backlog.md`, `docs/stage-reviews.md`, `docs/target-reviews.md` and `docs/evidence/backtests.md` are split out of `REQUIREMENTS.md`, so they are concatenated back into it. Every backlog idea then makes the CI gate "REQUIREMENTS.md up to date" fail until rebuilt, and under CLAUDE.md's rule it arguably needs a decisions-log entry. That is friction on the most frequent action in the process.
**Proposal:** run the first-run task verbatim (it must stay byte-identical), then in a second commit drop those four files from `docs:build` so they become standalone docs. `REQUIREMENTS.md` then contains only requirements. Log the decision.

---

## Group 2: decide during A1, before migrations are final

### 5. `check_results` will exceed the 500 MB Supabase limit (Decide)
A full-history pass over Tier 0 is about 10 tickers x ~8,000 trading days x ~15 checks = ~1.2M rows. At ~150-250 bytes per row with indexes, that is ~200 MB per pass. The weekly full refetch adds one pass per week, so storage fills in 2-3 weeks.
**Proposal:** store every non-green result in full; store green results only as one summary row per (run, layer, check) with counts and the max observed deviation. `data_health` per date stays complete. This changes storage, not checking: every check still runs on every bar.

### 6. Revision log will be flooded by provider re-adjustments (Decide)
Tiingo rewrites `adjClose` for the whole history after every dividend; Yahoo rewrites split-adjusted closes after every split. With "never silently overwrite", each SPY dividend logs ~8,000 revisions (TLT/IEF pay monthly). Real revisions (the ones layer G exists for) get buried. The same problem hits our own `adj_close` if it is back-adjusted: every new dividend rewrites history, and the weekly recomputation would annotate forward records for no real change.
**Proposal:**
- Revision log tracks raw fields only: open, high, low, unadjusted close, volume, dividend, split.
- Provider-adjusted values keep the latest snapshot plus one "provider re-adjustment" event per refetch (date range, implied factor). They are only used for return comparisons, which are scale-invariant.
- Define our adjusted series as a **forward-accumulated total-return index** (starts at 1.0 on the first date, history never changes). Signals like price > SMA on the total-return series are scale-invariant, so testfol semantics are unaffected. Incremental vs full recomputation becomes exact.

### 7. Rate and FX calendars differ from the NYSE calendar (Decide)
- FRED `DTB3` is published the next business day (after the 08:17 JST run) and is missing on bond-market holidays when the NYSE is open (Columbus Day, Veterans Day).
- ECB publishes no rates on TARGET holidays (e.g. May 1, Dec 26), some of which are NYSE trading days.

Under "primary data missing = red", every strategy holding cash or synthetic leverage (including the A2 thin slice) would go to its safe state on those days.
**Proposal:** rates and FX are point-in-time series: the value for date D is "last value published as of the run". Expected gaps (from versioned holiday tables) are green; unexpected gaps are yellow; staleness beyond a fixed limit (e.g. 5 business days, set now and not tuned later) is red. FX health affects yen valuation only, never a USD-based signal. Assumption to confirm: daily cash accrual uses the last published DTB3 (one-day lag), which is what the backtester must also do.

### 8. Fallback to Yahoo contradicts the severity rules (Decide)
Import schedule: "3 attempts, then the secondary source". Severity rules: "primary data missing = red". It is undefined whether a Yahoo-only day is yellow or red, and whether Yahoo bars may become canonical.
**Proposal (pillar 1):** a Yahoo-only day is **red** for signals (safe state applies). Yahoo data stays in `bars_raw`; `bars` is only filled from Tiingo. If the owner prefers continuity, the alternative is yellow with `primary_source = yahoo`, but then a single unofficial source can drive leveraged trades.

### 9. Yahoo is likely blocked from GitHub Actions, and the gate does not notice (Decide)
The A1 gate counts layer B only "on days where Yahoo was available", so it passes with zero Yahoo days. But "secondary unavailable = yellow", so production would be permanently yellow, the "green on >= 99% of days" pillar target becomes unreachable, and layer B (the main independent price check) does nothing.
**Proposal:** add a pre-registered A1 criterion now, before any data is seen: Yahoo reachable from Actions on >= X% of runs (suggest 90%, counting the 12:17 JST retry). If it fails, stop and choose between: another free secondary source (check terms), running the secondary fetch from a non-cloud machine, or a paid source within the existing budget rule.

### 10. "Recorded adapter responses in CI" conflicts with "never commit market data" (Decide)
The repo is public. Recorded Tiingo/Yahoo responses are market data (and Tiingo's free plan is internal use). testfol parity "every commit" needs 30+ years of real SPY bars; testfol daily equity CSVs are derived market data too.
**Proposal:**
- Committed fixtures are **synthetic** bars in the providers' exact response shapes (covers parsing, un-splitting, fault injection).
- Real-data tests (testfol parity, checks on real history, core vs reference on live data) run in a workflow that reads bars from Supabase with a read-only secret, on push to `main` and weekly, never on fork PRs.
- Commit only testfol summary stats; keep equity CSVs out of the repo.

### 11. Hash canonicalization is undefined, and round-trips break it (Decide, before A2)
"sha256(canonical YAML + registered_at)" and "sha256(prev_hash + canonical entry)" have no defined canonical form. YAML output changes with library versions; Postgres `jsonb` reorders keys and `numeric` can change number formatting. Chain verification would then fail on data read back from the database. Forward entries are immutable, so this must be right before the first one is written.
**Proposal:** hash the RFC 8785 (JCS) canonical JSON of the zod-parsed object (strategy) or entry. Store the exact hashed payload as `text` next to the structured columns. Verification rehashes the stored text and checks it matches the structured columns. Timestamps as ISO 8601 UTC strings.

### 12. Signed git tags do not prove *when* (Decide, before A2)
The owner holds the signing key and controls tag dates, so a signed tag proves who, not when. "Registered on date X" needs a third-party timestamp. Also, the OpenTimestamps JavaScript client is, as far as I know, LGPL-3.0 (verify), which the dependency rule excludes.
**Proposal:** RFC 3161 timestamps from a free timestamp authority via `openssl ts` in the Actions job (no npm dependency; store the token in `chain_anchors.proof`), or OpenTimestamps through its calendar HTTP API. Also commit chain heads to the public repo as secondary evidence. Anchor **daily** instead of weekly (it costs nothing and shrinks the unanchored window from 7 days to 1).

### 13. Public sign-ups are open by default (Fix)
Supabase Auth allows sign-ups by default. Anyone could create an account on the owner's instance, read global tables, and create strategies that jobs would evaluate (Tiingo quota, storage).
**Proposal:** disable sign-ups in the A1 Supabase setup; jobs evaluate only versions owned by the instance owner or the library. Related: library versions have `owner_id = null`, so their SELECT policy must be `owner_id is null or owner_id = auth.uid()`. This is a documented exception to the RLS rule in CLAUDE.md.

---

## Group 3: process and spec clarifications

### 14. A1 forces ~2 weeks of idle time (Decide)
A1 requires >= 10 calendar days of daily runs, and "nothing beyond A1 starts until its gate passes".
**Proposal:** during the observation window, allow A2 **development** on synthetic or stored data, with no registration, no forward records and no production alerts. A2 goes live only after the gate passes. Integrity is unaffected because nothing is registered. Needs a decisions-log entry.

### 15. "100% fault detection" needs a scope (Decide)
On a day when Yahoo is unavailable, a missed dividend or a swapped ticker on QQQ, IEF, TLT or GLD has no independent check (FRED `SP500` covers SPY only; the leverage-ratio check covers leveraged ETFs only). Also, FRED `SP500` has only 10 years, so the SPY-vs-index check cannot cover full history in A1.
**Proposal:** define the fault-injection target as "100% detection with all sources available", plus a separate assertion that a single-source day is never green. State the 10-year limit of the index check in `docs/data-spike.md`.

---

## Later, not blocking now
- **MCP read-only credential (E1):** Supabase has no read-only API key. Plan a dedicated Postgres role with SELECT grants and its own RLS policies.
- **Tax FX convention (C1):** which rate applies (trade-date TTM vs settlement TTS/TTB) depends on the broker and settlement currency. Already flagged for owner verification in 07.

## Suggested order
1. Items 1-3 (now), first-run task, then item 4.
2. Decide items 5-13 and 15 before writing the Stage A migrations; record them in the split files and decisions log.
3. Item 14 when A1's observation window starts.

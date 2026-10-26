# 04. Data pipeline (pillar 1)

## Sources and roles
Every source is a plug-in (15). Plug-ins suggest a role; the admin assigns roles in Settings:
- **Primary:** the canonical source for a data kind. Its values are what calculations use.
- **Secondary:** an independent source used for cross-checks (layer B) and, under the rules below, as a stand-in when the primary is missing. More than one secondary may be assigned.
- **Check:** used only for verification (layers C and D), never as a value.

Default plug-ins for the owner's install (to be confirmed in A1; limits and terms verified and recorded in `docs/data-spike.md`):

| Data kind | Role | Source | Plug-in | Notes (verify in A1) |
|---|---|---|---|---|
| Daily bars | Primary | Tiingo (free Starter) | Public | Official API, BYOK. 500 unique symbols/month, 50 requests/hour, 1,000/day, 30+ years. Personal, internal use. |
| Daily bars | Secondary (candidates) | Alpaca market data (free Basic: consolidated data from 2016, 200 calls/min); Massive, formerly Polygon (free: end-of-day, 2 years, 5 calls/min, individual use) | Public | Official APIs. A1 evaluates both; one or both become secondaries. |
| Daily bars | Secondary (history) | Yahoo Finance via `yahoo-finance2` | Private | Unofficial. Its "close" is already split-adjusted (un-split before comparing). The only free secondary with 30+ years, so it covers full-history checks. |
| Issuer data (best effort) | Check | ETF issuer websites: daily NAV, distributions, splits | Private | Formats vary. A check, not a gate. |
| Daily FX (USD/base) | Primary | ECB euro reference rates (USD/JPY as a cross) | Public | Daily valuation. No rates on TARGET holidays. |
| Daily FX | Secondary | Yahoo `JPY=X`; FRED `DEXJPUS` (weekly, H.10, New York noon) | Private / public | Cross-checks. |
| FX for tax | Primary | Broker-style rates (TTM/TTS/TTB), e.g. a bank's published daily rates | Private | Used by the tax engine (07), as the tax regime requires. Source chosen in C1. |
| Cash rates | Primary | FRED `DTB3` (USD T-bill); deposit rate for the base currency (admin setting, actual current rate) | Public / setting | `DTB3` is published the next business day and is missing on bond-market holidays. |
| Independent index check | Check | FRED `SP500` | Public | 10 years only, price index. |
| Event calendar (F1) | Primary | Federal Reserve (FOMC), BLS (CPI, jobs report) | Public | Versioned static data. |

Rejected for v1: Stooq (key required, unclear terms), Alpha Vantage (25 requests/day), Twelve Data free, EODHD free (20 calls/day). Paid upgrades only with owner approval: Tiingo Power ($30/month), Norgate, EODHD.

## What is imported
| Data | Fields | Use |
|---|---|---|
| Daily bars | date, open, high, low, unadjusted close, volume, dividend cash, split factor | All calculations |
| Provider adjusted values | adjClose (Tiingo, Yahoo), Yahoo split-adjusted close | Cross-checks only |
| Issuer data | NAV, distributions, splits | Cross-checks (layer D) |
| Ticker metadata | inception date, exchange, active status | Validation, warm-up, history disclosure |
| Rates, FX, index | DTB3, deposit rate, ECB rates, DEXJPUS, SP500 | Cash, leverage cost, base-currency valuation, sanity checks |

No indicators, signals or derived series are imported.

## Import schedule
- **Bootstrap:** full history from all sources.
- **Daily:** an hourly timer on the server runs the daily job **once per trading day**, at the first check after the day's data is final (time measured in A1). It fetches the last 10 trading days for every ticker in use (the overlap catches late corrections), issuer data, FX and rates. A run that did not finish is retried at the next check; data still missing stays `pending` and is retried. Catch-up covers every unprocessed trading day (e.g. after the server was off).
- **Upserts** go through a **revision log** (old value, new value, source, time); stored data is never silently overwritten. *(Open, item 6 of `docs/pre-build-issues.md`: how provider re-adjustments of adjusted values are logged, and whether our adjusted series is a forward-accumulated total-return index.)*
- **Weekly:** full-history refetch and diff; changes go to the revision log and trigger recomputation.
- **Retries:** through the plug-in SDK's HTTP client (backoff, per-source caps). A source that refuses (403, 429) is stopped for the run.
- **Calendars:** NYSE holidays and half-days, bond-market holidays and ECB (TARGET) holidays from versioned static tables.
- **Manual fallback:** validated CSV import.
- **Quota guard:** each plug-in declares its provider's limits; the SDK never goes above 80% of any of them.

## Point-in-time series (rates, FX, index)
- The value of a series for trading date D is the **last value published as of the run** (`asOf(series, D)`). One shared function serves the live pipeline and the backtester, so a backtest never uses a value the live run could not have had (no look-ahead).
- Expected gaps (known holidays of that series' calendar) are green. Unexpected gaps are yellow. Staleness beyond 5 business days is red.
- FX health affects only base-currency valuation and tax, never a signal computed in USD.
- Assumption: daily cash accrual and synthetic leverage cost use the last published `DTB3` (one-day lag).

## What is calculated
Adjusted (total-return) series from raw close, dividends and splits; daily returns; daily cash returns (USD and base currency); synthetic leverage; base-currency series; indicators (06); signals; allocations; equity curves; tax (07); metrics; statistics (09).

## Verification layers
| Layer | Check | Default tolerance | Frequency |
|---|---|---|---|
| A. Bar validation | Prices > 0; high ≥ max(open, close); low ≤ min(open, close); volume ≥ 0; no duplicates; trading days only; flag moves > 25% (1x) or > 60% (3x); flag unchanged close for 2+ days | As stated | Every bar |
| B. Cross-source | Raw close: primary vs each secondary (after un-splitting Yahoo) | ≤ 0.05% | Daily |
| | Dividend and split events match | Exact dates, ≤ 1% amounts | Daily |
| | **Daily returns** of our adjusted series vs each provider's adjusted series (not levels, which drift over decades) | ≤ 0.02pp per day | Daily |
| | FX: primary vs secondary; FRED once published | ≤ 0.5% | Daily / weekly |
| C. Economic sanity | Daily return of SSO ≈ 2x, UPRO/SPXL ≈ 3x SPY; QLD ≈ 2x, TQQQ ≈ 3x QQQ | Volatility-scaled: 0.5pp + 10% of the absolute expected move; ex-dividend days adjusted (leveraged ETFs track the index, not SPY) | Daily |
| | SPY daily return vs FRED S&P 500 index return | ≤ 0.1pp (ex-dividend adjusted); covers the last 10 years only | Daily |
| D. Issuer reconciliation (best effort) | Market close vs issuer NAV within normal premium/discount; distributions and splits match issuer records | Per-ETF thresholds set in A3 | Daily |
| E. Calculation integrity | Incremental vs full recomputation | ≤ 1e-9 relative (exact only where the window is recomputed) | Weekly |
| | Independent reference implementation of the core math (adjusted series, indicators, signals, equity curves; not tax) | ≤ 1e-9 relative, with near-tie handling (06) | Every commit (synthetic data) and weekly on real data |
| | External golden values: testfol parity, TradingView-verified indicator values, owner-computed tax cases | See 13 | Every commit / weekly on real data |
| F. Fault injection | Material corruptions (decimal shifts, missed splits or dividends, stale closes, missing days, duplicates, swapped tickers, timezone shifts) must be detected and must never produce a normal signal, with all sources available. Separately: a day with a single source is never green. | 100% of material faults | Every commit |
| G. Revisions | Weekly diff; recompute and report which past signals would have differed (forward records annotated, never edited) | Any change | Weekly |
| H. Liveness | Heartbeat ping on full success; daily data-health report; monthly audit report | n/a | Daily / monthly |

Checks, tolerances and rationale are documented in `docs/data-pipeline.md`.

**Storage of results:** daily runs store every check result. Weekly full-history passes store every non-green result in full and one summary row per (run, layer, check) with counts and the largest deviation. Every check still runs on every bar.

## Severity rules
| Situation | Status |
|---|---|
| All checks pass | Green |
| A secondary source, issuer site or FX cross-check unavailable; a mismatch within 2x tolerance; a single-day layer C deviation within 3x tolerance | Yellow |
| Primary data missing with no usable stand-in (below); layer A failure; mismatch above 2x tolerance; layer C deviation above 3x tolerance or repeated 3 days | Red |

### Primary missing, secondary present (automatic, no human decision)
1. The secondary bar for day D must pass layer A, and layer C where it applies. If two or more secondaries are available, they must agree within layer B tolerance. Otherwise: red.
2. **Decision-margin test:** each affected strategy's signals are recomputed with the stand-in price moved up and down by an uncertainty band. The band is the tolerance of the tightest independent check that passed that day: layer B tolerance when two secondaries agree, 0.1pp when SPY matched the FRED index, otherwise the layer C tolerance. If no signal can flip within the band: **yellow** ("secondary source only"). If any could: **red for that strategy only**.
3. At most 2 stand-in days in a row per ticker; the 3rd is red.
4. When the primary's value for D arrives, layer B compares it with the stand-in. A mismatch above tolerance goes to the revision log, annotates the forward record (never edits it) and alerts: "D's signal used a secondary price that was off by X; with the corrected price it would have been Y."

Stand-in bars are stored as raw data from their source; the canonical bar records which source it came from.

## Fail-closed behavior and safe state
- **Yellow:** signals are computed; every alert and screen shows the warning and reason.
- **Red:** no normal signal is presented for strategies depending on the affected data. Each strategy declares a **safe state** (default for leveraged strategies: 1x of the underlying; user can choose cash). The alert says: "Data unreliable today. Your strategy's safe action is X," with exact instructions. The safe state is recorded in the forward record as such.
- Status appears on the dashboard, in every alert, in every MCP response about signals, and in the audit report.

## Storage, keys, budget
- A SQLite file on the server (12). Database size and free disk on the admin page; warn at 70% of disk.
- BYOK: provider keys live in the server's `.env`, at install level (market data is shared by the install's accounts). Plug-ins read them; the web app never needs them.
- No paid service until free genuinely limits a robust system, and only with owner approval.


# 04. Data pipeline (pillar 1)

## Sources
| Role | Source | Access | Notes (verify in A1) |
|---|---|---|---|
| Primary daily bars | Tiingo (free Starter) | Official API, free key | 500 unique symbols/month, 50 requests/hour, 1,000/day, 30+ years. Internal use only. |
| Secondary daily bars | Yahoo Finance via `yahoo-finance2` | Unofficial, no key | Its "close" is already split-adjusted (un-split before comparing). Cloud IPs are often throttled, so it may be unavailable from GitHub Actions; unavailability is yellow, never red. |
| Issuer data (best effort) | ETF issuer websites: daily NAV, distributions, splits | Official, free, formats vary | Independent of vendors. A check, not a gate. |
| Daily FX (USD/JPY) | ECB euro reference rates (USD/JPY derived as a cross), cross-checked with Yahoo `JPY=X` | Official, free, daily | Used for daily yen valuation. |
| FX confirmation | FRED `DEXJPUS` | Official API | Published weekly (H.10), New York noon rate; confirms recent days once available. |
| FX for tax | Broker-style rates (TTM/TTS/TTB), e.g. a bank's published daily rates | Official, free (source chosen in C1) | Used by the tax engine (07), never the NY noon rate. |
| Cash rates | FRED `DTB3` (USD T-bill); JPY deposit rate (configurable, actual current rate) | Official | |
| Independent index check | FRED `SP500` | Official API | 10 years, price index, never redistributed |
| Event calendar (F1) | Federal Reserve (FOMC), BLS (CPI, jobs report) | Official, yearly | Versioned static data |

Rejected for v1: Stooq (key required, unclear terms), Alpha Vantage (25 requests/day), Twelve Data free, EODHD free.

## What is imported
| Data | Fields | Use |
|---|---|---|
| Daily bars | date, open, high, low, unadjusted close, volume, dividend cash, split factor | All calculations |
| Provider adjusted values | adjClose (Tiingo, Yahoo), Yahoo split-adjusted close | Cross-checks only |
| Issuer data | NAV, distributions, splits | Cross-checks (layer D) |
| Ticker metadata | inception date, exchange, active status | Validation, warm-up, history disclosure |
| Rates, FX, index | DTB3, JPY deposit rate, ECB rates, DEXJPUS, SP500 | Cash, leverage cost, yen valuation, sanity checks |

No indicators, signals or derived series are imported.

## Import schedule
- **Bootstrap:** full history from all sources.
- **Daily (JST morning, after US data is final):** last 10 trading days for every ticker in use (overlap catches late corrections), issuer data, FX and rates. Upsert with a **revision log** (old value, new value, source, time); never silently overwrite. A retry run later the same day processes anything still pending.
- **Weekly:** full-history refetch and diff; changes go to the revision log and trigger recomputation.
- **Retries:** 3 attempts with backoff, then the secondary source; if both fail, the date stays `pending`.
- **Calendar:** NYSE holidays and half-days from a versioned static table.
- **Manual fallback:** validated CSV import.
- **Quota guard:** never above 80% of any Tiingo limit.

## What is calculated
Adjusted (total-return) series from raw close, dividends and splits; daily returns; daily cash returns (USD and JPY); synthetic leverage; yen series; indicators (06); signals; allocations; equity curves; tax (07); metrics; statistics (09).

## Verification layers
| Layer | Check | Default tolerance | Frequency |
|---|---|---|---|
| A. Bar validation | Prices > 0; high ≥ max(open, close); low ≤ min(open, close); volume ≥ 0; no duplicates; trading days only; flag moves > 25% (1x) or > 60% (3x); flag unchanged close for 2+ days | As stated | Every bar |
| B. Cross-source | Raw close: Tiingo vs Yahoo (after un-splitting Yahoo) | ≤ 0.05% | Daily |
| | Dividend and split events match | Exact dates, ≤ 1% amounts | Daily |
| | **Daily returns** of our adjusted series vs each provider's adjusted series (not levels, which drift over decades) | ≤ 0.02pp per day | Daily |
| | FX: ECB-derived vs Yahoo; FRED once published | ≤ 0.5% | Daily / weekly |
| C. Economic sanity | Daily return of SSO ≈ 2x, UPRO/SPXL ≈ 3x SPY; QLD ≈ 2x, TQQQ ≈ 3x QQQ | Volatility-scaled: 0.5pp + 10% of the absolute expected move; ex-dividend days adjusted (leveraged ETFs track the index, not SPY) | Daily |
| | SPY daily return vs FRED S&P 500 index return | ≤ 0.1pp (ex-dividend adjusted) | Daily |
| D. Issuer reconciliation (best effort) | Market close vs issuer NAV within normal premium/discount; distributions and splits match issuer records | Per-ETF thresholds set in A3 | Daily |
| E. Calculation integrity | Incremental vs full recomputation | ≤ 1e-9 relative (exact only where the window is recomputed) | Weekly |
| | Independent reference implementation of the core math (adjusted series, indicators, signals, equity curves; not tax) | ≤ 1e-9 relative, with near-tie handling (06) | Every commit and weekly on live data |
| | External golden values: testfol parity, TradingView-verified indicator values, owner-computed tax cases | See 13 | Every commit |
| F. Fault injection | Material corruptions (decimal shifts, missed splits or dividends, stale closes, missing days, duplicates, swapped tickers, timezone shifts) must be detected and must never produce a normal signal | 100% of material faults | Every commit |
| G. Revisions | Weekly diff; recompute and report which past signals would have differed (forward records annotated, never edited) | Any change | Weekly |
| H. Liveness | Heartbeat ping on full success; daily data-health report; monthly audit report | n/a | Daily / monthly |

Checks, tolerances and rationale are documented in `docs/data-pipeline.md`.

## Severity rules
| Situation | Status |
|---|---|
| All checks pass | Green |
| Secondary source, issuer site or FX cross-check unavailable; a mismatch within 2x tolerance; a single-day layer C deviation within 3x tolerance | Yellow |
| Primary data missing; layer A failure; mismatch above 2x tolerance; layer C deviation above 3x tolerance or repeated 3 days | Red |

## Fail-closed behavior and safe state
- **Yellow:** signals are computed; every alert and screen shows the warning and reason.
- **Red:** no normal signal is presented for strategies depending on the affected data. Each strategy declares a **safe state** (default for leveraged strategies: 1x of the underlying; user can choose cash). The alert says: "Data unreliable today. Your strategy's safe action is X," with exact instructions. The safe state is recorded in the forward record as such.
- Status appears on the dashboard, in every alert, in every MCP response about signals, and in the audit report.

## Storage, licensing, budget
- Supabase free Postgres (500 MB); usage on the admin page; warn at 70%.
- BYOK: each instance uses its owner's Tiingo and FRED keys. Demo mode uses synthetic data only.
- Budget ¥0 until free genuinely limits a robust system. Candidates: Tiingo Power ($30/month), EODHD (about $19.99/month), J-Quants Light (¥1,650/month), a small VPS if GitHub Actions scheduling proves unreliable.


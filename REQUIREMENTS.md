<!-- split: docs/requirements/_header.md -->
# REQUIREMENTS.md

Project: **Saku** (策: strategy, plan; also 咲く: to bloom)
Owner: Raphael
Status: v0.7 (2026-10-26)
License: PolyForm Noncommercial 1.0.0

## For Claude Code: first-run task (do this before any development)
If `docs/requirements/` does not exist yet:
1. Split this file into separate files using the `<!-- split: path -->` markers. Everything between a marker and the next marker goes into the file named by the marker, **verbatim** (do not reword, summarize or reorder). This header block goes to `docs/requirements/_header.md`.
2. Create `scripts/docs-build` and a `pnpm docs:build` command that regenerates `REQUIREMENTS.md` by concatenating the split files in marker order, re-inserting each marker line. Run it and confirm the output is byte-identical to the original file. Report the result.
3. From then on, the split files are the source of truth. `REQUIREMENTS.md` is generated only; never edit it directly. CI fails if it is out of date.
4. Commit as `docs: split requirements` and stop for the owner's review before starting Stage A1.

If `docs/requirements/` already exists, ignore this section and follow `CLAUDE.md`.

<!-- split: docs/requirements/00-index.md -->
# Requirements index (start here)

## How to read
1. Read this index.
2. Read the file for the **current stage** in `stages/`. It lists the area files needed.
3. Read only the area files relevant to the task.
4. Read the full `REQUIREMENTS.md` only for the **completion check** at the end of a stage, or when the owner asks.

## Global constraints (apply to every task)
- Pillars in priority order: Reliability, Evidence, Decision clarity, Accessibility, Honesty and protection.
- The whole product is fully bilingual: English and Japanese (see 08).
- Never present a normal signal on doubtful data: yellow warns, red switches to the strategy's declared safe state (see 04).
- Default execution is next-day; same-close execution is only for testfol parity tests (see 05).
- Single owner per instance today, multi-user-ready data model; personal project; PolyForm Noncommercial 1.0.0; ¥0 budget unless the owner approves.

## Area files
| File | Contents | Read when working on |
|---|---|---|
| 01-vision-targets.md | Vision, pillars, product model, targets, target reviews, gate, v1 | Target and stage reviews, trade-offs |
| 02-process.md | Rolling wave, stage reviews, backlog, decision log, external reviews | Reviews, planning, new ideas |
| 03-assets.md | Asset tiers | Adding tickers or asset classes |
| 04-data-pipeline.md | Sources, imports, schedule, calculations, verification, health status, safe state | Anything touching data |
| 05-strategy-model.md | Strategy model, execution, versions, registration, YAML, positions | Engine, builder, strategy storage |
| 06-indicators.md | Indicators and numeric rules | Indicators, signals |
| 07-accounts-tax.md | NISA and taxable rules, tax engine, FX for tax, comparisons | Tax, accounts, yen results |
| 08-ux-language.md | Language, defaults, decision cards, metrics, guidance, acceptance | Any UI, content, alert text |
| 09-analytics.md | Robustness, statistics, Monte Carlo, library, finder | Robustness lab, library, finder |
| 10-mcp.md | MCP levels, export, context pack | MCP server, exports |
| 11-alerts.md | Alerts, channels, key-day alerts | Notifications |
| 12-architecture-stack.md | Stack, layout, compute placement, risks, non-functional, docs | Setup, infra, cross-cutting |
| 13-testing.md | Test strategy, parity, golden values | Tests |
| 14-decisions-log.md | Decision history | When a decision changes |

Other docs: `docs/system-design.md`, `docs/evidence/backtests.md`, `docs/backlog.md`, `docs/stage-reviews.md`, `docs/target-reviews.md`.

<!-- split: docs/requirements/01-vision-targets.md -->
# 01. Vision, pillars, product model, targets

## Vision
**The best personal investment assistant for rule-based investors: deep strategies on a few assets, verified with honest analytics, powered by free or near-free data, and operated through Claude via MCP.**

Longer term: make evidence-backed, professional-grade strategies usable by anyone, including people with little investment knowledge, with honest decisions and visible uncertainty.

## Pillars (priority order)
1. **Reliability.** We never act on wrong data or wrong calculations. Data and math are checked redundantly and independently. When data is in doubt, the tool never presents a normal signal: yellow status computes with a visible warning; red status switches to the strategy's declared safe state and tells the user exactly what to do.
2. **Evidence.** Strategies are grounded in published research, verified with robustness and overfitting statistics, and judged on forward (post-registration) results, which are tamper-evident.
3. **Decision clarity.** Every choice is shown as trade-offs in yen and ranges (return, bad-case loss, recovery time, costs, tax), so the user decides knowingly. The tool educates on decisions, not finance theory.
4. **Accessibility.** Professional methods usable without understanding the math, executable at a real Japanese broker with real costs, real execution timing and real tax.
5. **Honesty and protection** (cross-cutting). Show uncertainty and luck, never oversell, make risks impossible to miss.

## Product model
- **Personal project.** The owner is the user. Each instance has a single owner today.
- **Multi-user-ready data model:** every user-owned table has an `owner_id` with Row Level Security from day one, so family members can be added later (enable invites, small settings UI) without migration. Market data, checks, data health and the strategy library are shared per instance. Provider keys stay instance-level. Note: Tiingo's free plan is internal use; household use is a gray area, wider use needs per-person instances or a data-plan upgrade.
- **Hosted as a portfolio project:** the owner's instance is private (login required); public visitors see a demo mode with synthetic data.
- **Self-hostable:** others can fork and run their own instance with their own API keys (BYOK).
- **Commercial use** is not a goal; it may only be considered as a consequence of success.

## Audience
The owner first; designed so an individual with little investment knowledge can use it, in English or Japanese.

## Benchmark set
Judged in yen, after tax and costs, against what an individual in Japan would realistically hold. Index benchmarks are assumed held in **NISA** (tax-free), because that is the realistic alternative:
- S&P 500 index fund in NISA (modeled with SPY in yen minus fee)
- Global index fund in NISA (eMAXIS Slim All Country; modeled with VT in yen minus fee)
- Balanced 8-asset fund in NISA (ETF composite, defined in C2)
- Robo-advisor style portfolio (ETF mix, defined in C2)
- Gold (GLD in yen)
- Bank deposits (actual current JPY deposit rate)

## Outcome targets
Targets apply to a **strategy slice**, not the whole portfolio (the user may hold e.g. 50% in a safe core and 10% in an aggressive strategy). Measured on the **median rolling 5-year window**, with the share of windows meeting the target and a confidence range always reported. Backtests use next-day execution, realistic costs and tax.

| Tier | Target |
|---|---|
| Aggressive (default) | Beat S&P 500 buy and hold held in NISA by 5-10pp per year in yen after tax and costs, with max drawdown no worse than S&P 500's and higher Sharpe and Calmar ratios |
| Balanced | Match All Country (NISA) return with at most 60% of its max drawdown |
| Conservative | Beat the balanced 8-asset fund (NISA) with no worse max drawdown |

Initial evidence for the aggressive target: `docs/evidence/backtests.md` (pre-tax, same-close execution; re-run with next-day execution and tax at TR1). Whole-portfolio targets are defined at F5.

## Pillar targets
| Pillar | Target | Measurement |
|---|---|---|
| Reliability | 100% of injected material faults detected (faults larger than the relevant tolerance); zero normal signals presented on red data | Fault-injection suite (CI); audit log |
| Reliability (process) | Data status green on ≥ 99% of trading days (yellow and red tracked separately) | Data-health history |
| Evidence | 100% of library strategies cite research and show tamper-evident post-registration results | Library review; chain verification |
| Decision clarity | ≥ 4 of 5 test users correctly state a strategy's bad-case loss in yen after reading its page | Usability test (3-5 people) |
| Decision clarity | 100% coverage of the information-parity metric set for every strategy | Automated check |
| Accessibility | 100% tooltip coverage; on a deployed instance, a novice reaches a first strategy in < 15 minutes | CI check; usability test |
| Accessibility (language) | 100% of user-facing strings exist in EN and JA | CI check (enforced from D1) |
| Execution (process) | ≥ 95% of signals acted on within one trading day; live results inside the backtest's expected range | Discipline journal; forward tracking |

## Target reviews
| Review | When | Evidence |
|---|---|---|
| TR1 | After Stage B1 | Re-run evidence with next-day execution, costs and tax in yen; median and share of 5-year windows |
| TR2 | At v1 | Process targets, parity, first forward data, usability test |
| TR3 | After the strategy finder | Robustness and overfitting statistics, Monte Carlo probabilities |
| TR4 | After the whole-portfolio view | 12+ months of forward data in real yen |

Each review records evidence, decision (keep, raise, lower) and rationale in `docs/target-reviews.md`. Targets are never pursued by overfitting or by loosening integrity rules.

## Gate
If Stage A1 (data spike) fails its gate, stop and report to the owner.

## v1 definition
v1 = Stages A, B, C, D and E1, plus usability acceptance (08) and TR2.

<!-- split: docs/requirements/02-process.md -->
# 02. Process

## Rolling-wave planning
- **Stable:** vision, pillars, integrity rules.
- **Detailed:** the current and next stage.
- **Loose:** later stages, specified at the stage review before they start.

## Stage reviews
At the end of every stage: demo, retrospective (what worked, what didn't, what was learned), target review if due, completion check against `REQUIREMENTS.md`, then detailed planning of the next stage. Recorded in `docs/stage-reviews.md`.

## Backlog rule
New ideas during a stage go to `docs/backlog.md`, evaluated at the next stage review against the pillars. Uncertain ideas get a small, time-boxed experiment first.

## Decision log
Every change of direction is recorded in `14-decisions-log.md`.

## External reviews
Before development and at major stage reviews, the owner runs fresh review sessions with only the documents (no memory, no prior chat), one lens each: pre-mortem, red team, data pipeline, statistics, beginner UX, feasibility for one beginner developer. A human developer review is welcome.

<!-- split: docs/requirements/03-assets.md -->
# 03. Assets

Each tier needs its own data gate before its tickers are usable in strategies. A user-added ticker is usable only after passing the data quality checks (04) over its full history. The UI states each asset's history length and which crisis periods it covers.

| Tier | Assets | When | Notes |
|---|---|---|---|
| 0 (core) | SPY, SSO, UPRO, SPXL, QQQ, QLD, TQQQ, IEF, TLT, GLD. Cash (USD and JPY, see 05). | Stage A | SPY-centric. Thin slice (A2) uses SPY, SSO, UPRO and cash. Note short histories: IEF/TLT from 2002, GLD 2004, UPRO 2009 (earlier periods use synthetic leverage). |
| 1 | VT, VTI, IWM, EFA, VWO, SHY, AGG, TIP, VNQ, DBC, sector ETFs | C2 | Benchmarks and diversification; alternatives via ETF proxies. VT only from 2008. |
| 2 | Signal inputs, never tradable: FRED `BAMLH0A0HYM2`, `T10Y2Y`, `NFCI`, `UNRATE`, `VIXCLS`, `SP500` | F2 | Regime filters. |
| 3 | Large-cap US stocks | Later | Survivorship caveats. |
| 4 (optional) | Japanese ETFs and mutual fund NAVs (e.g. eMAXIS, つみたて-eligible funds) | Later | J-Quants free plan delayed 12 weeks; labeled US ETF proxies until then. |
| 5 (optional) | Crypto | Later | 24/7 calendar. |

No intraday data. Revisit only if auto-execution is ever added.

<!-- split: docs/requirements/04-data-pipeline.md -->
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

<!-- split: docs/requirements/05-strategy-model.md -->
# 05. Strategy model

## Strategies
- Unlimited strategies; detail view; side-by-side comparison of up to 4.
- testfol-style model, extended:
  - **Signals:** comparisons of indicators or thresholds; options `totalReturn`, `delayDays`, `tolerancePct` (percent, symmetric hysteresis); derived (NOT) and aggregate (AND/OR) signals; **ensemble signals** (vote across several signals; output = share agreeing).
  - **Allocations:** ordered priority chain with any number of fallbacks; first allocation whose conditions are true is active; last is an unconditional fallback. **Filtered fallbacks** through the chain (e.g. bonds only if bonds are above their own trend, else cash).
  - **Holdings:** fixed weights; **ranked blocks** (top N by an indicator); **exposure scaling** (volatility targeting in discrete steps across 0x/1x/2x/3x instruments; ensemble share can also scale exposure).
  - **Drawdown circuit breaker** (optional).
  - **Synthetic leverage:** `SPY?L=3&E=0.9`, daily return = L * r - (L - 1) * cashRate/252 - E/100/252.
  - **Cash:** `CASH_USD` (USD T-bill yield, carries FX exposure in yen terms) or `CASH_JPY` (JPY deposit rate; converting incurs FX spread and may realize taxable gains). Decision cards show the yen impact of either choice.
  - **Safe state** (required for every strategy, see 04).
  - **Trading frequency:** daily, weekly, monthly. **Costs:** slippage (bps), fees and FX spread, defaulting to the owner's broker schedule (C2).
  - **Account type:** 特定口座 by default; NISA where eligible (07).
- **Tolerance semantics:** true when value > ref * (1 + tolerancePct/100); false when value < ref * (1 - tolerancePct/100); otherwise unchanged. Initial state on the first valid day: plain comparison (value > ref). Verified against testfol parity.

## Execution model
- Signals are computed from a close that is final in the JST morning; the earliest realistic trade is the next US session.
- `execution: next_open | next_close | same_close`. **Default: next_open** (with slippage) for backtests, forward tracking and alerts.
- `same_close` exists only for testfol parity tests and is labeled "not achievable from Japan" wherever shown.
- Small amounts: optional whole-share modeling in backtests; the rebalance calculator always rounds to whole shares and shows residual cash.

## Versions and registration
- **Draft** strategies can be edited and backtested freely; they create no forward record.
- **Registering** a strategy creates an immutable StrategyVersion and starts its forward record. Edits to a registered strategy create a new draft.
- **Tamper-evident record:** each registration and each daily forward entry is hash-chained (each entry includes the hash of the previous), and chain heads are timestamped externally (e.g. signed git tags or OpenTimestamps), so "registered on date X, and every day since" is provable.
- The forward record stores what was actually signaled at the time (including safe-state days); later recomputations are annotations, never edits.

## YAML
Canonical YAML validated by zod; visual builder and YAML round-trip without loss.

```yaml
name: SPY 3x trend + vol filter (ensemble)
account: tokutei
execution: next_open
safeState: { holdings: [{ ticker: SPY, weight: 100 }] }
evaluation: { frequency: daily }
costs: { slippageBps: 5, feePct: 0.1, fxSpreadPct: 0.2 }
signals:
  - id: A
    type: ensemble
    members:
      - { left: { indicator: price, ticker: SPY, totalReturn: true }, op: ">", right: { indicator: sma, ticker: SPY, length: 150, totalReturn: true }, tolerancePct: 3 }
      - { left: { indicator: price, ticker: SPY, totalReturn: true }, op: ">", right: { indicator: sma, ticker: SPY, length: 200, totalReturn: true }, tolerancePct: 3 }
      - { left: { indicator: price, ticker: SPY, totalReturn: true }, op: ">", right: { indicator: sma, ticker: SPY, length: 250, totalReturn: true }, tolerancePct: 3 }
    threshold: 0.5
  - id: B
    type: compare
    left:  { indicator: volatility, ticker: SPY, length: 20 }
    op: "<"
    right: { threshold: 25 }
allocations:
  - name: Risk on
    when: { all: [A, B] }
    holdings: [{ ticker: "SPY?L=3&E=0.9", weight: 100 }]
  - name: Trend only
    when: { all: [A] }
    holdings: [{ ticker: SPY, weight: 100 }]
  - name: Cash
    holdings: [{ ticker: CASH_USD, weight: 100 }]
```

## Positions and journal
- A dated trade log (date, ticker, quantity, price, currency, fees, FX rate, account type); holdings derived; cash per currency.
- **Discipline journal** (v1): for each signal, the user records done / skipped / delayed (with date). Feeds the execution target and later the behavior-gap analysis.

## Entities
Settings, NotificationChannel (per user), Symbol, Bar, IssuerRecord, BarRevision, FxRate, CheckResult, DataHealthStatus, Strategy (draft), StrategyVersion (registered), StrategyState, ForwardEntry (hash-chained), ChainAnchor (external timestamp), PaperPortfolio, Trade, CashBalance, JournalEntry, NisaQuotaLedger, TaxLot, Alert, FinderCriteria, FinderResult, RobustnessReport, EventCalendar, JobRun.

<!-- split: docs/requirements/06-indicators.md -->
# 06. Indicators and numeric rules

All computed locally from verified data, each with documented formula, parameters and warm-up period (`docs/indicators.md` and tooltips, EN/JA).

- **v1:** Price, SMA, EMA, Return over N days, Volatility (close-to-close, sqrt(252)), Parkinson, Garman-Klass and Yang-Zhang volatility, Drawdown from N-day or all-time high, N-day High/Low, Threshold; tolerance bands on any comparison.
- **v1.1:** RSI, MACD, Bollinger Bands, ATR, moving-average slope, relative strength, rolling correlation.
- **Tier 2 (F2):** credit spread level and change, yield curve, NFCI, unemployment trend (Sahm-style), VIX, T-bill rate.

## Numeric rules
- float64 for prices, returns and indicators; decimal.js for money, tax and quotas.
- **Near-ties:** when a compared value is within 1e-9 (relative) of its reference, the comparison is a tie and the previous state is kept. Core and reference implementations apply the same rule; tie days are logged and are not treated as mismatches.
- Annualization uses 252 trading days.

<!-- split: docs/requirements/07-accounts-tax.md -->
# 07. Accounts and tax

## Roles of accounts
- **特定口座 (default):** where timing and leveraged strategies live.
- **NISA (opt-in per instance):** for the steady core and DCA plans. Timing strategies generally do not fit NISA: quota frees up only the following year, and つみたて投資枠 allows periodic purchases only.
- Holdings cannot be moved from 特定口座 into NISA; a "fallback to NISA" means selling (possibly taxable) and rebuying (using quota). The tool shows both costs.

## Enforced rules
| Rule | NISA 成長投資枠 | NISA つみたて投資枠 | 特定口座 |
|---|---|---|---|
| Leveraged products | Not eligible | Not eligible | Allowed |
| Eligible products | Listed stocks/ETFs and eligible funds | FSA-designated funds only (labeled ETF proxies until Japanese fund data exists) | All |
| Purchases | Lump sum or periodic | Periodic (DCA) only | Any |
| Annual quota | ¥2.4M | ¥1.2M | n/a |
| Lifetime limit | ¥18M shared (成長 max ¥12M); sold amounts free up quota the next year at book value | Same shared limit | n/a |
| Tax on gains | None | None | 20.315% on realized gains |
| Losses | No offset | No offset | Offset gains and dividends; 3-year carryforward via 確定申告 |
| US ETF dividends | 10% US withholding, no foreign tax credit | Same | Withholding + Japanese tax; foreign tax credit possible |

- A quota tracker shows annual and lifetime usage; the tool warns before and blocks any plan that would exceed limits.
- The owner (tax background) verifies all rules before C1 implementation.

## Tax engine
Tax lots; realized gains per switch using broker-style FX rates (TTM/TTS/TTB as applicable); loss offsets and carryforward; dividend withholding; NISA quota ledger. Hooks in the backtester from B1; completed in C1. Verified with owner-computed golden cases (no second implementation for tax).

## Tax-free vs taxable comparison
- Same period, in yen, after tax; taxable strategies on **liquidation value**.
- Rolling 5-year windows showing which approach won and by how much.
- Hybrid view: NISA core plus taxable satellite.

## Japan tax optimization (F4, candidate to pull earlier)
Asset location (what belongs in NISA vs 特定口座 given quota); year-end loss harvesting in 特定口座 (respecting cost-basis averaging rules for same-day repurchases); choosing December vs January for realizing gains.

<!-- split: docs/requirements/08-ux-language.md -->
# 08. UX, language, decision clarity

## Language (mandatory)
- The entire product is **fully available in English and Japanese**: every screen, tooltip, help panel, guided tour, glossary entry, decision card, chart label, error, empty state, alert, export header, user guide and README quickstart.
- No feature ships in one language only. The content package (`packages/content`) is used from day one; the CI translation gate is enforced from D1.
- Language switch on every page, stored in settings. Default: browser language, fallback English.
- Locale-aware dates, numbers, currency (¥, $) and percentages.
- Natural Japanese financial terminology (e.g. 最大ドローダウン, 特定口座), reviewed by the owner.
- Alerts in the selected language. Code, comments, commits and technical docs in English.

## Defaults instead of questionnaires
- One opinionated default: aggressive tier, leverage only in favorable conditions, parameter ensembles instead of single parameters, frequent fallbacks, 特定口座, next-day execution.
- All assumptions (tier, drawdown limit, example amount, costs, FX spread, cash currency, account type, execution, safe state) visible and editable. Default example amount: ¥100,000 (with whole-share effects shown).
- Risks (leverage, drawdown, tax, gap risk, short asset histories) shown clearly before a risky setting takes effect. No profiling quiz.

## Decision card (every strategy, fallback comparison and finder candidate)
- Return range (10th-90th percentile over 5 years) and median, not a single number.
- Bad-case and historical worst-case loss **in yen** for the user's amount; time to recover.
- Costs, FX and tax drag; NISA eligibility.
- What happens if the user deviates (quits at the bottom, delays re-entry).
- Comparison against the benchmark set (01), including S&P 500 in NISA.
- History length and crisis coverage; wide confidence ranges flagged.
- Plain-language verdict of the trade-off.

## Information-parity metric set (every strategy)
CAGR, cumulative return, volatility, downside deviation, Sharpe, Sortino, Calmar, max drawdown, average drawdown, longest drawdown and recovery time, Ulcer index, beta and correlation vs S&P 500 and All Country, VaR 95%, CVaR 95%, best and worst year, % positive months, rolling 5-year return range (median and share meeting target), switches per year, average exposure/leverage, cost drag, tax drag, deflated Sharpe ratio, probability of backtest overfitting.

## Guidance
- Tooltips on every metric, indicator, setting, column and chart element (definition, why it matters, example), EN/JA, coverage enforced in CI.
- "How to use this page" panel on every page; onboarding checklist; replayable guided tours; glossary; plain-language summaries above numbers; empty states and errors that say what to do next.
- Starter templates (buy and hold SPY, ensemble trend filter, owner's Setup 1 with ensemble, dual momentum), each with a decision card.
- User guide in `docs/user-guide/` (EN/JA), rendered in the app. Mobile-friendly, dark mode.
- A UI feature is done only when its guidance content exists in EN and JA.

## Acceptance (before v1)
3-5 test users unfamiliar with the tool, on a deployed instance, complete onboarding to a first alert with in-app guidance only (in their chosen language); at least 4 of 5 correctly state a strategy's bad-case loss in yen.

<!-- split: docs/requirements/09-analytics.md -->
# 09. Analytics: robustness, statistics, Monte Carlo, library, finder

## Robustness score components
| Component | Question | Measurement | Display example |
|---|---|---|---|
| Parameter stability | Only works at one setting? | % of neighboring parameter sets beating the benchmark risk-adjusted | "82% of nearby settings also work" |
| Time stability | Works across periods? | % of walk-forward folds beating the benchmark | "Won in 7 of 10 periods" |
| Crisis survival | Protects when it matters? | Drawdown vs benchmark in 2000-02, 2008, 2020, 2022 (only those covered by data, stated) | "Passed 3 of 4 crises" |
| Statistical confidence | Could it be luck? | Bootstrap (block) p-value of the edge, adjusted for the effective number of independent trials | "Results this good would appear 6% of the time with no edge" |
| Live decay | Still works after registration? | Forward vs backtest Sharpe | "Live results in line with backtest" |

Benchmark calibrated to about 50; weakest-link aggregation (geometric mean, capped by the weakest component); "insufficient data" when history is too short.

## Overfitting statistics (shown alongside the score)
- **Deflated Sharpe ratio** and **probability of backtest overfitting** (combinatorially symmetric cross-validation), both from Bailey and López de Prado, using the effective number of independent trials (not the raw count).

## Score validation (pre-registered)
- The formula is written in `docs/robustness-score.md` and approved by the owner **before** any validation is run.
- Known-answer tests: random-entry median ≤ 35; deliberately over-optimized ≤ 40; benchmark 45-55.
- Predictive check: run **once** on a held-out period not used to design the formula; the result is recorded in `docs/robustness-score.md` whatever it is. Any revision is logged with its reason and validated only on data not used in earlier attempts. Never iterate until it passes.

## Monte Carlo goal projection
**Block bootstrap of the underlying asset returns** (preserving volatility clustering and autocorrelation), then re-run the strategy on each simulated path. Output: probability of reaching a user goal (e.g. ¥100,000 to ¥300,000 in 5 years), including contribution plans.

## Strategy library
- 10-15 strategy families with parameter variants (up to about 100 registered variants), in `library/`, approved by the owner before seeding (B2).
- Every family cites its research basis in `docs/strategy-library.md`. Candidate references to verify: Faber (2007) tactical asset allocation; Moskowitz, Ooi and Pedersen (2012) time-series momentum; Antonacci (2014) dual momentum; Moreira and Muir (2017) volatility-managed portfolios; Cheng and Madhavan (2009) leveraged ETF dynamics; Gayed and Bilello (2016) leverage with moving-average rules; McLean and Pontiff (2016) post-publication decay; Bailey and López de Prado (deflated Sharpe, backtest overfitting).
- Parameter ensembles preferred over single parameters. Assume edges decay after publication; judge on post-registration results. Immutable once registered. No curated risk profiles.

## Finder behavior
- Always-visible panel comparing library strategies (and optionally the user's other strategies) against a chosen user strategy. Top 10 candidates (tentative).
- **Ranked on long-run robustness**, not recent performance: after-tax risk-adjusted results over full history with next-day execution, robustness score, deflated Sharpe. Recent forward results are a sanity check, not a trigger.
- Per candidate: metrics, decision card, tier ("Watch" / "Consider switching"), "qualifying for N days", "Add to my strategies" (the copy starts as a draft).
- Hysteresis on the ranking score to keep the list stable. Suggests only; never switches automatically.

## Finder default criteria (all configurable)
- **Eligibility:** registered ≥ 6 months; robustness score ≥ 60; probability of backtest overfitting ≤ 0.3; volatility within ±25% and same leverage class; ≤ 12 switches per year; account-type eligible.
- **Consider switching (all must hold):** long-run Sharpe ≥ user's + 0.2 and Calmar ≥ user's, with ≥ 90% confidence after the luck check; max drawdown no worse than user's + 2pp; forward results inside the candidate's expected range; estimated after-tax benefit exceeds the switching cost (tax, fees, FX) within 3 years.
- **Watch:** passes eligibility and most switching criteria.
- 12-month forward performance is shown as information only.
- Cost model before C1: 20.315% tax on realized gains plus broker fee and FX spread defaults (editable).

## Finder integrity
Luck check ("N qualify; about M would by luck alone"; no "Consider switching" unless N clearly exceeds M); no look-ahead; finder self-test (follow suggestions vs stay) shown on the panel; optional notifications (20 consecutive days in "Consider switching", 6-month cooldown).

<!-- split: docs/requirements/10-mcp.md -->
# 10. MCP server and AI export

The app makes no LLM calls. Claude is used on request through MCP within the owner's Claude plan.

## Level 1: read-only (E1, in v1)
- Tools: strategies and versions; YAML; current state with data-health status; backtests on demand (in memory, nothing persisted); forward results with chain verification status; positions, trades and journal; decision cards; tax comparisons; data-health and audit reports.
- No database writes, no notifications. Read-only credential.

## AI export
UI button, CLI and MCP tool producing a compact bundle: Markdown summary + JSON (YAML, key stats, downsampled equity, switches, forward vs backtest). Default under 20,000 characters.

## Context pack (on request only)
Exposures (effective leverage, asset mix, account mix, yen and USD cash exposure, rate sensitivity), signal state and regime history (from B3), for Claude to combine with current news and produce scenarios (base/bear/bull, what the strategy would do in each) for 6-month, 1, 3 and 5-year horizons.

## Level 2 (F6) and level 3 (F7)
- Level 2: natural-language strategy building (YAML validated by the same schema; creates drafts only), save backtests, add finder candidates.
- Level 3: trades, journal entries, notification settings; destructive actions require explicit confirmation.

## General
Local stdio server for Claude Desktop first. Compact responses; long series downsampled; signal responses include data-health status.

<!-- split: docs/requirements/11-alerts.md -->
# 11. Alerts and notifications

## Channels
Discord webhook first, configured per user in the database (a channel per user); the owner's job-failure alerts may use an env webhook. Email, Telegram, LINE in the backlog. Alerts in the user's selected language.

## Alert types
| Alert | When | Stage |
|---|---|---|
| Strategy state change | Active allocation changes; states the execution timing (e.g. "trade at the next US open") | A2 |
| Data health | Yellow (warning) or red (safe-state action with exact instructions) | A2 |
| Job failure | Owner | A2 |
| Position mismatch | Holdings differ from target; includes rebalance calculator orders (whole shares) | D1 |
| Strategy health | Live drawdown exceeds the worst 5% predicted by the backtest | D2 |
| Key-day alert | Before an important US session | F1 |
| Finder | Optional (see 09) | F3 |

Every alert states the data-health status. Idempotent per (strategy version, trading date, alert type).

## Key-day alerts (F1, right after v1)
- Sent around 21:00 JST when a scheduled event (FOMC, CPI, jobs report), signal proximity (close near a threshold) or stress state (volatility spike, large prior-day drop) makes the session important.
- Contents: why it matters, precomputed price levels, suggested pre-session stop orders (SBI US order types and validity verified in F1).
- Backtested with daily OHLC (fill at the stop, or at the open on gaps, plus slippage). Capped frequency, ranked by severity. On by default only if it improves after-tax risk-adjusted results.

<!-- split: docs/requirements/12-architecture-stack.md -->
# 12. Architecture, stack, non-functional

## Tech stack
| Area | Choice | Notes |
|---|---|---|
| Runtime | Node.js current Active LTS, pinned in `.nvmrc` | |
| Language | TypeScript `strict` | |
| Monorepo | pnpm workspaces + Turborepo | |
| Web | Next.js (App Router) with React | One deployable for UI and API routes; prefer client components unless server rendering clearly helps |
| UI | Tailwind CSS + shadcn/ui | |
| Charts | TradingView Lightweight Charts; ECharts or Recharts for heatmaps and distributions (chosen in D1) | |
| i18n | next-intl | |
| Client data | TanStack Query | |
| Validation / YAML | zod, `yaml` | |
| Database | Supabase Postgres (Tokyo), SQL migrations via Supabase CLI, generated types, supabase-js | |
| Auth | Supabase Auth: single owner account now, invites can be enabled later; RLS on all user-owned tables | |
| Jobs | Node CLI (tsx) in GitHub Actions | |
| Numerics | float64 analytics; decimal.js for money, tax, quotas | |
| Dates | date-fns + @date-fns/tz | |
| Logging | pino | |
| Market data | `yahoo-finance2`; Tiingo, FRED, ECB, issuers via fetch | |
| Integrity | SHA-256 hash chain; external timestamping (signed git tags or OpenTimestamps, decided in A2) | |
| MCP | `@modelcontextprotocol/sdk` | |
| Testing | Vitest, fast-check, Playwright | |
| Lint/format | ESLint, Prettier | |
| Hosting | Vercel Hobby, Supabase free, GitHub Actions, healthchecks.io, Discord webhook | ¥0 |

Dependencies must be compatible with PolyForm Noncommercial (MIT, Apache 2.0, BSD, ISC); no GPL/AGPL.

## Compute placement
Heavy computation (robustness sweeps, Monte Carlo, library evaluation) runs in GitHub Actions jobs or in the browser (Web Workers), never in Vercel serverless functions (time limits). Results are stored and displayed.

## Layout
```
apps/web, apps/jobs, apps/mcp
packages/core (engine, backtester, tax), packages/reference (independent core math),
packages/analytics, packages/data (adapters, verification, fault injection, calendar),
packages/db, packages/notify, packages/export, packages/content (EN/JA), packages/config
library/, templates/, fixtures/testfol/, scripts/docs-build
docs/ (requirements/, system-design.md, evidence/, data-pipeline.md, indicators.md, parity.md,
       robustness-score.md, strategy-library.md, backlog.md, stage-reviews.md, target-reviews.md,
       data-spike.md, user-guide/)
```
The owner's personal notes are kept outside the repository (the repo is public).

## Free-tier risks
| Risk | Mitigation |
|---|---|
| Cron delays or drops | Off-peak schedule; idempotent catch-up; daily retry run |
| Public-repo schedules disabled after 60 days without activity; forks have schedules disabled by default | Keep-alive; documented in quickstart; heartbeat |
| Supabase pauses after 1 week of inactivity | Daily job activity; verified over ≥ 10 calendar days in A1 |
| Yahoo throttling of cloud IPs | Secondary only; yellow, never red |
| Issuer website changes | Best-effort layer; yellow on failure |

## Non-functional
- Security: RLS; keys encrypted; secrets in GitHub/Vercel env; service-role key only in jobs; no keys or market data in the repo; MCP level 1 read-only.
- Observability: JobRun table, structured logs, admin page (runs, freshness, checks, storage, quotas, chain status).
- Performance: 30-year daily backtest < 2 s; nightly library evaluation < 5 min; one robustness sweep < 2 min (jobs or browser).
- Disclaimer: "not financial advice"; data accuracy not guaranteed, health status shown (EN/JA).

## Documentation and clone-and-run
- `README.md` quickstart (EN/JA): fork; create Tiingo and FRED keys; Supabase project; secrets; `bootstrap`; enable GitHub Actions in the fork; heartbeat; deploy; confirm data health is green.
- `docs/data-pipeline.md`, `docs/indicators.md`, `docs/user-guide/` (EN/JA), troubleshooting.

<!-- split: docs/requirements/13-testing.md -->
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

<!-- split: docs/requirements/14-decisions-log.md -->
# 14. Decisions log

- 2026-09-28: TypeScript/Node/React monorepo; Supabase; Vercel; GitHub Actions; Discord first; BYOK.
- 2026-09-30: PolyForm Noncommercial 1.0.0; MCP read-only first.
- 2026-10-04: Tier 0 SPY-centric universe; indicators computed locally; tiered asset expansion; beginner-first UX.
- 2026-10-06: Five pillars; tiered and pillar targets; process; issuer reconciliation, reference implementation, fault injection; macro tier; volatility targeting, ensembles, filtered fallbacks; NISA and 特定口座 with tax engine; decision cards; stages A-F; key-day alerts after v1; no intraday.
- 2026-10-07: Name Saku. Full EN/JA requirement explicit. Next.js kept.
- 2026-10-07 (external review): single owner per instance (hosted portfolio demo, self-hostable); targets apply to a strategy slice, median rolling 5-year window, vs S&P 500 in NISA after tax, with evidence file; declared safe state on red data; next-day execution default (same-close only for parity); ECB daily FX, FRED as weekly confirmation, broker-style FX for tax; USD vs JPY cash; Yahoo un-splitting and return-based comparisons; volatility-scaled layer C; severity rules; near-tie rule; reference implementation for core math only, external golden values emphasized; issuer data best effort, not a gate; A1 run ≥ 10 calendar days; thin slice (A2) to start forward records early; draft vs registered versions; tamper-evident hash chain; deflated Sharpe and backtest-overfitting probability; pre-registered score validation; block-bootstrap Monte Carlo; library 10-15 families; finder ranked on long-run robustness; parameter ensembles by default; discipline journal in v1; NISA opt-in with quota enforcement, timing strategies in 特定口座; Japan tax optimization added (F4); whole-share handling; heavy compute off Vercel; usability test 3-5 users; translation CI gate from D1; owner notes outside the repo.
- 2026-10-26: Multi-user-ready data model (owner_id + RLS on user-owned tables, per-user notification channels) while staying single owner; provider keys instance-level since market data is shared.

<!-- split: docs/requirements/stages/stage-a.md -->
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

<!-- split: docs/requirements/stages/stage-b.md -->
# Stage B: Evidence engine (Evidence)

Read for this stage: 05-strategy-model.md, 06-indicators.md, 09-analytics.md, 13-testing.md, 07-accounts-tax.md (tax hooks), 04-data-pipeline.md (layer E, fail-closed), `docs/evidence/backtests.md`.

## B1. Engine, backtester, reference implementation
- Full strategy model: indicators v1, signals (tolerance, delay, ensembles), chains, ranked blocks, exposure scaling, circuit breaker, synthetic leverage, USD/JPY cash, costs, execution models, whole-share option, tax hooks.
- Reference implementation of the core math, written in a separate session that never reads `packages/core`.
- External golden values; testfol parity (same_close).
- **TR1:** re-run the evidence with next-day execution, costs and estimated tax in yen; report median and share of 5-year windows.

## B2. Daily evaluation, library, forward records
- Evaluate all registered strategies daily (fail-closed, safe state); hash-chained forward records.
- Seed the library (10-15 families, owner approves `docs/strategy-library.md` first).

## B3. Robustness lab and statistics
- Parameter sweeps, walk-forward, block bootstrap, crisis replays; robustness score (formula approved first, pre-registered validation); deflated Sharpe and probability of backtest overfitting; Monte Carlo goal projection; regime history for the context pack.

> **Completion check:** when Stage B is believed done, read the full `REQUIREMENTS.md`, confirm every Stage B item and relevant requirement, list gaps, then run the stage review.

<!-- split: docs/requirements/stages/stage-c.md -->
# Stage C: Decision layer (Decision clarity, Honesty)

Read for this stage: 07-accounts-tax.md, 08-ux-language.md, 01-vision-targets.md (benchmarks), 03-assets.md (Tier 1), 04-data-pipeline.md (FX for tax, Tier 1 gate).

## C1. Accounts and tax engine
- Account roles and enforced rules; NISA opt-in and quota tracker with warnings and blocks; tax lots; broker-style FX for tax; loss offsets and carryforward; dividend withholding; owner-computed golden cases. Owner verifies rules first.

## C2. Decisions and benchmarks
- Tier 1 data gate; benchmark set (compositions defined); decision cards; full metric set; tax-free vs taxable comparison; defaults; cost defaults from the owner's broker (fees, FX spread).

> **Completion check:** when Stage C is believed done, read the full `REQUIREMENTS.md`, confirm every Stage C item and relevant requirement, list gaps, then run the stage review.

<!-- split: docs/requirements/stages/stage-d.md -->
# Stage D: Daily operation (Accessibility)

Read for this stage: 08-ux-language.md, 05-strategy-model.md, 11-alerts.md, 12-architecture-stack.md, 07-accounts-tax.md (quota view).

## D1. Web UI
- Login (single owner), demo mode with synthetic data, settings, language switch, onboarding, guidance (EN/JA, translation CI gate on).
- Strategy list, detail, comparison, builder (visual + YAML), drafts and registration, starter templates.
- Backtest and robustness views with decision cards; charts with indicators, switch markers, bar replay.
- Positions (trade log), rebalance calculator (whole shares, residual cash), NISA quota view, discipline journal UI.
- Dashboard, data-health page (status, checks, revisions), chain verification status.

## D2. Paper trading and health
- Paper portfolios with costs, tax and DCA contribution plans (つみたて-style periodic plans).
- Forward vs backtest expected range; decay detection; strategy health alert.

> **Completion check:** when Stage D is believed done, read the full `REQUIREMENTS.md`, confirm every Stage D item and relevant requirement, list gaps, then run the stage review.

<!-- split: docs/requirements/stages/stage-e.md -->
# Stage E: Claude layer (can run in parallel with C and D)

Read for this stage: 10-mcp.md, 04-data-pipeline.md (health status in responses).

## E1. MCP level 1, AI export, context pack
As specified in 10-mcp.md.

## v1 done
Stages A-E1 complete, usability acceptance (08) passed, TR2 recorded.

> **Completion check:** when v1 is believed done, read the full `REQUIREMENTS.md`, confirm every v1 requirement, list gaps, then run the stage review and TR2.

<!-- split: docs/requirements/stages/stage-f.md -->
# Stage F: Expansion (after v1; order and details decided at stage reviews)

- **F1. Key-day alerts** (next after v1): 11-alerts.md.
- **F2. Macro and credit signal tier:** Tier 2 data gate (03), indicators (06).
- **F3. Strategy finder:** 09-analytics.md. **TR3.**
- **F4. Japan tax optimization:** asset location, year-end loss harvesting, December vs January realization (07). Candidate to pull earlier.
- **F5. Whole-portfolio view:** core holdings plus strategies; effective exposure; stress tests in yen; time vs money-weighted returns; CVaR sizing; dividend log; behavior-gap analysis from the journal; whole-portfolio targets. **TR4.**
- **F6. MCP level 2**, **F7. MCP level 3:** 10-mcp.md.
- **F8. Sharing:** strategy config plus verifiable forward record (hash chain), never market data.
- **F9-F11 (optional):** Tier 3 stocks, Tier 4 Japanese assets, Tier 5 crypto, each with its own data gate.

## Backlog
Email/Telegram/LINE; summary digests; SBI CSV trade import; watchlist; screener (very low); auto-execution (optional, separate risk review; reopens intraday); factor regression (low value).

> **Completion check:** at the end of each F item, read the full `REQUIREMENTS.md`, confirm consistency, list gaps, then run the stage review.

<!-- split: docs/evidence/backtests.md -->
# Evidence: initial backtests (testfol.io, run by the owner)

Period 1996-09-27 to 2026-09-25 (30 years). Simulated S&P 500 (SPYSIM) and simulated leverage (`SPYSIM?L=3&E=0.9`), daily trading, USD, **same-close execution, before tax and FX**.

| Strategy | CAGR | Max drawdown | Longest drawdown | Volatility | Sharpe |
|---|---|---|---|---|---|
| S&P 500 buy and hold | 10.38% | -55.14% | 6.58 years | 19.30% | 0.49 |
| 3x buy and hold | 11.96% | -98.29% | 19.61 years | 57.89% | 0.45 |
| 3x + 200-day SMA filter (else cash) | 15.42% | -71.17% | 14.26 years | 36.97% | 0.51 |
| Setup 1: 3x if trend up (SMA 200, ±3% tolerance) and 20-day volatility < 25%; 1x if trend up only; else cash | 19.90% | -54.63% | 4.46 years | 36.23% | 0.62 |
| Setup 2: same, but 1x instead of cash (found by accident) | 20.52% | -65.95% | 7.34 years | 39.06% | 0.62 |

## Caveats (must accompany these numbers)
- Before tax: switches in 特定口座 realize 20.315% tax on gains.
- Same-close execution is not achievable from Japan; next-day execution will reduce results.
- Leverage is simulated, not real ETF history (UPRO exists only from 2009).
- Parameters were chosen after seeing results; Setup 2 was selected because it looked best (selection bias).
- One strategy family on one index; a single 30-year history (about six non-overlapping 5-year windows).
- USD terms; yen results depend on FX.

Interpretation: Setup 1's pre-tax edge over S&P 500 (+9.5pp/year) is near the aggressive target range. Whether it survives tax, next-day execution and the future is what TR1 and forward records will show.

<!-- split: docs/backlog.md -->
# Backlog

| Date | Idea | Raised by | Pillar | Status (new / accepted / rejected / experiment) | Notes |
|---|---|---|---|---|---|

<!-- split: docs/stage-reviews.md -->
# Stage reviews

## Stage X review (YYYY-MM-DD)
- **Demo:**
- **Completion check (gaps found and resolved):**
- **What worked:**
- **What didn't:**
- **What we learned:**
- **Backlog decisions:**
- **Target review (if due):**
- **Next stage plan (stage file updated):**

<!-- split: docs/target-reviews.md -->
# Target reviews

## TRn (YYYY-MM-DD)
- **Evidence (with confidence ranges):**
- **Targets assessed:**
- **Decision (keep / raise / lower, per target):**
- **Rationale:**
- **Integrity note (no tuning to reach targets):**

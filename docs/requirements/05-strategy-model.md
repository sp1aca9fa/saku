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


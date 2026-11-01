# Indicators and signals

Formulas, parameters and warm-up of every indicator (requirements 06), and how signals turn them into a state. Code: `packages/core/src/strategy/`. The reference implementation (`packages/reference`) computes the same independently; external golden values (testfol, TradingView) take precedence over both.

## Series

- **Price** (`totalReturn: false`): closes split-adjusted to the latest share basis (a later split rescales all past values by the same factor, so comparisons with the fund's own average and volatility do not change). A comparison with a fixed level does change (a close of 15 above a level of 10 reads 7.5 after a 2-for-1 split), so a plain `price` or `sma` against a `threshold` is refused at parse, by `pnpm strategy check` and registration (decisions log 2026-11-01, C18 (a)): compare the fund with its own average instead. A total-return series against a fixed level depends on where the stored history starts (the index is 1.0 on the first stored day), and comparing two funds' price levels changes with either one's split; whether to refuse those too is open (owner decision C26). `volatility` against a threshold is allowed (a percentage, not rescaled).
- **Total return** (`totalReturn: true`): our total-return index (`docs/data-pipeline.md`), dividends reinvested on the ex-date.

## Indicators (A2)

| Indicator | Formula | Parameters | Warm-up |
|---|---|---|---|
| `price` | The series value on the date | ticker, totalReturn | none |
| `sma` | Mean of the last `length` series values | length >= 1 | length - 1 bars |
| `volatility` | Sample standard deviation (n - 1) of the last `length` simple daily returns of the series, x sqrt(252), x 100 (percent per year) | length >= 2 | length bars |
| `threshold` | A fixed number (volatility thresholds in percent) | value | none |

Each value is computed from its own window, so a longer history never changes it (incremental and full recomputation agree).

Assumptions to settle with golden values: volatility uses the sample standard deviation (n - 1) and simple returns; testfol's or TradingView's definition may use n or log returns.

## Indicators (B1, v1)

The contract for both `packages/core` and `packages/reference`; each implements it from this text alone. `v` is the series (price or total return), `N` is `length`, `ln` the natural log. Percent values are x 100.

| Indicator | Formula | Parameters | Warm-up |
|---|---|---|---|
| `ema` | alpha = 2 / (N + 1). The first value (at bar N - 1) is the mean of the first N values; then EMA_t = alpha x v_t + (1 - alpha) x EMA_t-1 | length >= 1 | length - 1 bars |
| `return` | (v_t / v_t-N - 1) x 100 | length >= 1 | length bars |
| `volatility`, `method: close` | As in A2 above (the default when `method` is left out) | length >= 2 | length bars |
| `volatility`, `method: parkinson` | sqrt(252 x S / (4 ln 2 x N)) x 100, S = sum over the last N days of (ln(H/L))^2 | length >= 1 | length - 1 bars |
| `volatility`, `method: garman_klass` | sqrt(252 x mean over the last N days of [0.5 (ln(H/L))^2 - (2 ln 2 - 1)(ln(C/O))^2]) x 100 | length >= 1 | length - 1 bars |
| `volatility`, `method: yang_zhang` | sqrt(252 x (s_o + k s_c + (1 - k) s_rs)) x 100 over the last N days: s_o the sample variance (n - 1) of ln(O_t / C_t-1), s_c the sample variance of ln(C_t / O_t), s_rs the mean of ln(H/C) ln(H/O) + ln(L/C) ln(L/O), k = 0.34 / (1.34 + (N + 1) / (N - 1)) | length >= 2 | length bars |
| `drawdown` | (v_t / max(v over the last N values, today included) - 1) x 100, at most 0. Without `length`: the maximum since the series' first value (all-time high) | length >= 1 or none | length - 1 bars, or none |
| `high`, `low` | The maximum (minimum) of the last N series values, today included | length >= 1 | length - 1 bars |

- **Open, high and low on the series' basis:** each day's O, H and L are scaled by the same factor as that day's series value against its raw close (price: the split adjustment; total return: the index value / the raw close). Ratios within a day (H/L, C/O) are then the raw ones; the overnight ratio O_t / C_t-1 includes the day's dividend and split. A day without an open, high or low gives no value for any window holding it (never estimated from the close). All four of the day's values are scaled the same way: series O, H, L, C = raw O, H, L, C x (series value / raw close), so equal raw values stay exactly equal and a flat day gives exactly 0. A missing open, high or low, a high below a low, an open or close outside [low, high], or a non-positive or non-finite value is a data error layer A already reports; every range method (`parkinson`, `garman_klass`, `yang_zhang`) gives no value for any window holding that day. For `yang_zhang` the day before the window supplies only its close. A negative or non-finite variance gives no value. `return` and `drawdown` give no value when a value they read is not positive or not finite (the all-time `drawdown` from that day on); a non-finite `ema` gives no value; `high` and `low` give no value when a value they read is not finite.
- **History dependence:** `ema` and the all-time `drawdown` depend on every value since the series' first one; incremental and full recomputation still agree (same stored history), but a history that starts earlier (a longer refetch) changes them slightly. Every other indicator depends only on its own window.
- **Fixed levels:** `ema`, `high` and `low` on plain prices against a `threshold` are refused like `price` and `sma` (C18 (a)); `return`, `volatility` and `drawdown` are percentages and allowed. Total-return levels and cross-fund price levels: open (C26).

Assumed, to settle with golden values (TradingView, testfol): the EMA seed is the mean of the first N values (TradingView's convention); `high`/`low` read series values (closes on the series' basis), not the day's highs and lows; `return` is simple, not log.

## Signals

- **compare:** `left op right`, `op` is `>` or `<`. With `tolerancePct` t, for `>`: true when left > right x (1 + t/100), false when left < right x (1 - t/100), otherwise unchanged (`<` mirrors it). The first valid day is a plain comparison.
- **Near-ties:** a value within 1e-9 (relative) of the bound it would cross is a tie: the state does not change, and the tie is logged. On the first day a tie with the reference is false.
- **ensemble:** members are compare signals, each with its own state; the output is the share of members true; the signal is true when the share is at least `threshold` (assumption: "at least", so 1 of 2 is true at 0.5).
- **Allocations:** the first allocation whose `when` holds is active (`all`: every named signal true; `any`: at least one; `none`: none of them); the last has no `when`.
- A date is evaluated when every ticker the signals read has a bar that day, from the first date every signal is defined. On a date that is not evaluated because one operand has no value (for example a range volatility over a day without a low), the comparisons that do have values still update their tolerance-band state (core and reference agree; noted in the backlog for review).

## Equity curves (backtests)

- **Execution:** `next_open` (default): a decision at a close is traded at the next session's open; `next_close`: at the next close; `same_close`: at the deciding close, for testfol parity only and labeled "not achievable".
- **Returns:** close to close; with `next_open` the session is split at the open: the night (previous close to open) goes to the old holdings, with the ex-date dividend and the split; the day (open to close) to the new ones.
- **Cash** (`CASH_USD`): the USD rate (percent a year, as known before the session) / 252 per night held; none for the open-to-close part.
- **Synthetic leverage** (`SPY?L=3&E=0.9`): L x the base's return, minus (L - 1) x the cash rate / 252 and E / 100 / 252 per night held.
- **Weights:** set to the allocation's weights at each trade, then drift with prices until the allocation changes (no rebalancing within an allocation; assumption until testfol parity says otherwise).
- **Costs:** (slippage bps / 10,000 + fee %) x turnover at each trade, turnover being the sum of absolute weight changes (an entry from nothing counts 1, a full switch 2).
- **Summary:** CAGR over calendar time (365.25-day years), maximum drawdown from the previous peak.


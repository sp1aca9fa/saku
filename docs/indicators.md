# Indicators and signals

Formulas, parameters and warm-up of every indicator (requirements 06), and how signals turn them into a state. Code: `packages/core/src/strategy/`. The reference implementation (`packages/reference`) computes the same independently; external golden values (testfol, TradingView) take precedence over both.

## Series

- **Price** (`totalReturn: false`): closes split-adjusted to the latest share basis (a later split rescales all past values by the same factor, so comparisons and volatility do not change).
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

## Signals

- **compare:** `left op right`, `op` is `>` or `<`. With `tolerancePct` t, for `>`: true when left > right x (1 + t/100), false when left < right x (1 - t/100), otherwise unchanged (`<` mirrors it). The first valid day is a plain comparison.
- **Near-ties:** a value within 1e-9 (relative) of the bound it would cross is a tie: the state does not change, and the tie is logged. On the first day a tie with the reference is false.
- **ensemble:** members are compare signals, each with its own state; the output is the share of members true; the signal is true when the share is at least `threshold` (assumption: "at least", so 1 of 2 is true at 0.5).
- **Allocations:** the first allocation whose `when` holds is active (`all`: every named signal true; `any`: at least one; `none`: none of them); the last has no `when`.
- A date is evaluated when every ticker the signals read has a bar that day, from the first date every signal is defined.

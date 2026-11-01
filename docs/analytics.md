# Analytics

Formulas of the metrics shown with every strategy (requirements 08, "Information-parity metric set"). Code: `packages/core/src/analytics/`. The reference implementation (`packages/reference`) computes the same from this text alone, without reading core; external golden values (testfol, the owner's cases) take precedence over both. Robustness, deflated Sharpe and probability of backtest overfitting (requirements 09) come later in this file.

## Metrics

The contract for both `packages/core` and `packages/reference`. Each metric is either a value or "no value" with a reason; a doubtful or too short input never gives a number, and an unknown is never read as 0.

### Interface

```ts
type TradingDate = string; // 'YYYY-MM-DD', America/New_York

interface EquitySample { date: TradingDate; equity: number }

interface MetricsPoint extends EquitySample {
  /** Weights held at the date's close (shares summing to 1), keyed by ticker. */
  weights?: Record<string, number>;
  /** True when the strategy traded on the date. */
  traded?: boolean;
}

interface MetricsInput {
  /** The strategy's equity, one point per session (a backtest's points fit). */
  points: readonly MetricsPoint[];
  /** The cash's simple return over the session ending at the date's close; undefined when unknown. */
  cashReturn?: (date: TradingDate) => number | undefined;
  /** Benchmarks' equity by id (any ids, e.g. two indexes chosen by the install). */
  benchmarks?: Record<string, readonly EquitySample[]>;
  /** The same backtest with zero costs, on the same dates (for cost drag). */
  gross?: readonly EquitySample[];
  /** Downside deviation's target: 'cash' (default) or 'zero'. */
  downsideTarget?: 'cash' | 'zero';
  /** A yearly return (0.1 = 10% a year) the rolling 5-year windows are measured against. */
  rollingTarget?: number;
}

type NoValueReason =
  | 'tooShort'          // fewer points, returns, periods or windows than the metric needs
  | 'equityNotPositive' // a series used has an equity value <= 0 (wiped out)
  | 'cashRateMissing'   // the cash return is unknown on a date the metric needs
  | 'noDispersion'      // the spread the metric divides by is (numerically) zero
  | 'noDrawdown'        // Calmar: the maximum drawdown is (numerically) zero
  | 'holdingsMissing'   // weights or trade flags missing or unreadable
  | 'grossMissing';     // cost drag without a zero-cost run

type Metric<T> = { ok: true; value: T } | { ok: false; reason: NoValueReason };

function metrics(input: MetricsInput): MetricSet; // fields in "Metrics" below
```

Results are fractions (0.1 = 10%), never percent; the UI formats them. Day counts are calendar days.

### Input rules

- **Refused (throws):** a date that is not a real `YYYY-MM-DD` calendar date; dates not strictly ascending (in `points`, any benchmark or `gross`); an equity value that is not a finite number; a weight that is not a finite number; `gross` whose dates are not exactly those of `points`; a `rollingTarget` that is not a finite number. These are caller errors, not data states.
- **Wiped out:** when any equity in `points` is <= 0, every metric is no value (`equityNotPositive`): returns after a zero or negative value are undefined. A benchmark (or `gross`) with an equity <= 0 makes only its own metrics no value (`equityNotPositive`).
- **Empty or one point:** every metric is no value (`tooShort`).
- **Which reason when several apply:** fewer than 2 points (`tooShort`) first, then a wiped-out `points` (`equityNotPositive`); then per metric in this order. `beta`, `correlation`: the benchmark wiped out, too few aligned returns, `sd(b)`, then (`correlation`) `sd(s)`. `downsideDeviation`, `sharpe`, `sortino`: too few returns, the cash return, the spread. `calmar`: `cagr`'s reason, then `noDrawdown`. `switchesPerYear`: `holdingsMissing`, then the span. `costDrag`: `grossMissing`, then `gross`'s CAGR reason (fewer than 2 points, wiped out, span), then that of `points`.
- **Cash return:** a value that is undefined or not finite is unknown (`cashRateMissing` for every metric that needs it); it is never replaced by 0. The caller derives it point in time (`asOf`), e.g. the yearly cash rate known before the session / 252, as the backtest accrues cash.

### Notation

- `n` points `e_0 .. e_(n-1)` on dates `t_0 .. t_(n-1)`.
- Simple daily returns `r_i = e_i / e_(i-1) - 1` for `i = 1 .. n-1`; `m = n - 1` returns. Returns are simple, never log.
- `days(a, b)`: calendar days from date `a` to date `b` (both read as UTC midnight; an exact integer).
- `span = days(t_0, t_(n-1))`; `years = span / 365.25`.
- `mean(x) = sum(x) / count`; sample standard deviation `sd(x) = sqrt(sum((x - mean(x))^2) / (count - 1))` (n - 1, as the `volatility` indicator).
- Annualization: 252 trading days a year (requirements 06): a daily mean x 252, a daily spread x sqrt(252). Calendar-time growth uses 365.25-day years.
- **Constants:** `MIN_RETURNS = 20` (statistics of the return distribution need at least 20 daily returns: one trading month, and the 5% tail of VaR holds at least one day); `MIN_SPAN_DAYS = 365` (yearly figures need at least one year: as in the GIPS standards, returns over shorter periods are not annualized); `DISPERSION_FLOOR = 1e-12` (a daily spread at or below it is zero: float rounding of a cash-only curve, never a real spread); `TIE = 1e-9` (relative, the near-tie rule: a drawdown within it of the peak is at the peak).
- **Drawdown series:** running peak `P_i = max(e_0 .. e_i)`; drawdown `d_i = e_i / P_i - 1` (<= 0; `d_0 = 0`). A point is **under water** when `d_i < -TIE`.
- **Drawdown episodes:** a maximal run of consecutive under-water points `a .. b` (`a >= 1`). Its peak is point `a - 1`; its trough the point of the smallest `d` in `a .. b` (the first one on a tie); its depth that `d`; it is recovered at point `b + 1` when `b + 1 <= n - 1` (that point is not under water), else unrecovered.
- **Calendar periods:** a trading date's year is its first 4 characters, its month its first 7 (`YYYY-MM`), so years and months are cut in America/New_York trading dates. A period is **complete** when the series has at least one point in the calendar period just before it and at least one in the calendar period just after it (January's previous month is December of the year before). Its return is `e(last point in it) / e(last point in the period before) - 1`. Partial first and last periods are never counted.

### Metrics

| Id | Value | Formula | Needs (else no value) | Source |
|---|---|---|---|---|
| `cagr` | number | `(e_(n-1) / e_0)^(1 / years) - 1` | `span >= MIN_SPAN_DAYS` (`tooShort`) | Compound annual growth rate; GIPS (no annualizing under a year) |
| `cumulativeReturn` | number | `e_(n-1) / e_0 - 1` | `n >= 2` | |
| `volatility` | number | `sd(r) x sqrt(252)` | `m >= MIN_RETURNS` | As the close-to-close `volatility` indicator |
| `downsideDeviation` | number | `sqrt(sum(min(0, r_i - g_i)^2) / m) x sqrt(252)`, `g_i` the target: `cashReturn(t_i)` (`downsideTarget: 'cash'`, the default) or 0 (`'zero'`). The sum runs over all `m` returns, those above the target counting 0, and divides by `m` (not `m - 1`) | `m >= MIN_RETURNS`; with the cash target every `g_i` known (`cashRateMissing`) | Sortino and Price (1994), target semideviation |
| `sharpe` | number | Excess returns `x_i = r_i - c_i`, `c_i = cashReturn(t_i)`; `mean(x) / sd(x) x sqrt(252)` | `m >= MIN_RETURNS`; every `c_i` known (`cashRateMissing`); `sd(x) > DISPERSION_FLOOR` (`noDispersion`) | Sharpe (1994), ex-post ratio of the differential return; sqrt(252) scaling assumes independent days (Lo 2002) |
| `sortino` | number | `mean(x) / sqrt(sum(min(0, x_i)^2) / m) x sqrt(252)`, `x` as for `sharpe` (target: the cash return, whatever `downsideTarget` is) | as `sharpe`; the denominator's daily value `> DISPERSION_FLOOR` (`noDispersion`) | Sortino and Price (1994); numerator the yearly mean excess return (arithmetic, as Sharpe) |
| `calmar` | number | `cagr / abs(maxDrawdown)` | `cagr` has a value (its reason otherwise); `maxDrawdown < -TIE` (`noDrawdown`) | Young (1991); over the whole period and daily drawdowns, not Young's trailing 36 months |
| `maxDrawdown` | number (<= 0) | `min(d_0 .. d_(n-1))` (exact, no tie rule) | `n >= 2` | |
| `averageDrawdown` | number (<= 0) | Mean depth of all drawdown episodes, an unrecovered one included; 0 when there is none | `n >= 2` | Mean of the episodes' deepest points (as PerformanceAnalytics `AverageDrawdown`), not the mean of every day's drawdown |
| `longestDrawdown` | `{ days, peak, trough, recovery, recoveryDays, depth }` or `null` | The episode with the most `days` (the earliest on a tie). `days = days(peak date, recovery date)`, unrecovered: `days(peak date, t_(n-1))` (so far). `recovery`: the recovery date or `undefined` (not recovered yet); `recoveryDays = days(trough date, recovery date)`, `undefined` when not recovered. `null` when there is no episode | `n >= 2` | Duration from the peak to the first point back at it |
| `ulcerIndex` | number | `sqrt(sum(d_i^2) / n)` over all `n` points (a fraction; x 100 is Martin's percent figure) | `n >= 2` | Martin and McCann (1989), with the running peak since the first point instead of a 14-day lookback |
| `beta` | `Record<id, Metric<number>>` | Per benchmark: align by date (the dates both series have, in order: `a_0 .. a_k`); returns over consecutive aligned dates `s_j = e(a_j) / e(a_(j-1)) - 1` (strategy) and `b_j` (benchmark), `j = 1 .. k`; `cov(s, b) / var(b)`, both sample (`k - 1`). Raw returns, not excess | `k >= MIN_RETURNS`; `sd(b) > DISPERSION_FLOOR` (`noDispersion`); the benchmark's equity > 0 (`equityNotPositive`) | Sharpe (1964) / CAPM beta, on raw rather than excess returns |
| `correlation` | `Record<id, Metric<number>>` | As `beta`: `cov(s, b) / (sd(s) sd(b))`, clamped to [-1, 1] (rounding) | as `beta`, and `sd(s) > DISPERSION_FLOOR` | Pearson correlation |
| `var95` | number (a daily return) | Sort `r` ascending `r_(1) <= .. <= r_(m)`; `k = ceil(m / 20)` (integer arithmetic: `floor((m + 19) / 20)`); `r_(k)`, no interpolation | `m >= MIN_RETURNS` | Historical simulation, daily, 95% |
| `cvar95` | number (a daily return) | `mean(r_(1) .. r_(k))`, `k` as for `var95` (the average of the worst 1 in 20 days, the VaR day included) | `m >= MIN_RETURNS` | Historical expected shortfall (Acerbi and Tasche 2002) without the fractional weight of the boundary day |
| `bestYear`, `worstYear` | `{ year, return, years }` | Over complete calendar years: the highest (lowest) return, the earliest year on a tie; `years` = how many complete years | at least one complete year (`tooShort`) | |
| `positiveMonths` | `{ share, positive, months }` | Over complete calendar months: `positive` = months with a return > 0 (0 is not positive), `share = positive / months` | at least one complete month (`tooShort`) | |
| `rolling5y` | `{ median, min, max, windows, share, meeting }` | For every point `i`: `D` = `t_i` five calendar years earlier (`(Y - 5)-MM-DD`; Feb 29 becomes Feb 28 when that year has none); `s` = the last point with `t_s <= D` (none: no window ends at `i`). Window growth `(e_i / e_s)^(365.25 / days(t_s, t_i)) - 1` (yearly). `median` of all windows (mean of the two middle values for an even count), `min`, `max`, `windows` the count. With `rollingTarget`: `meeting` = windows with growth `>= rollingTarget`, `share = meeting / windows`; without it both `undefined`. Windows overlap (one per session), so they are not independent | at least one window (`tooShort`) | Requirements 01 (median rolling 5-year window, share meeting the target) |
| `switchesPerYear` | number | `S / years`, `S` = points with `traded` true, less 1 when there is any (the first trade is the entry, not a switch, as the backtest counts) | every point has `traded` (`holdingsMissing`); `span >= MIN_SPAN_DAYS` (`tooShort`) | |
| `averageExposure` | number | `mean(x_0 .. x_(n-2))`, `x_i = sum over the weights at point i of weight x L`: the weights each return period starts from (the last point's weights earn nothing in the series). `L` is the ticker's `L` parameter (`SPY?L=3&E=0.9` is 3; 1 without it; `CASH_USD` is 0). Net: an inverse ticker (L < 0) lowers it. No weights (before the first trade) is 0 | every point `0 .. n-2` has `weights` and every `L` is a finite number (`holdingsMissing`); `n >= 2` | |
| `costDrag` | number | `cagr(gross) - cagr(points)`: yearly growth lost to costs (positive = costs cost that much a year) | `gross` given (`grossMissing`); both `cagr` values (their reason otherwise, `equityNotPositive` from `gross` too) | |

Notes:

- **Sample length:** `MIN_RETURNS` and `MIN_SPAN_DAYS` stop meaningless numbers, not noisy ones: 20 days of returns still give a very uncertain Sharpe. The UI shows the period the metrics cover with them.
- **Cost drag source:** the backtest does not return a zero-cost curve; the caller runs it a second time with `costs: {}` (the decisions, and so the trades, are the same). TODO (wiring, with the strategy page): no caller does this yet.
- **Not in this section yet:** tax drag (stage C, after-tax results), deflated Sharpe ratio and probability of backtest overfitting (requirements 09, next).
- **Golden values:** testfol's Sharpe, volatility and longest drawdown (`docs/evidence/backtests.md`) may use other definitions (population spread, a cash rate over the whole period, calendar-day vs session durations); parity cases settle it, and a difference changes this contract only through the decisions log.

### Assumed (definitions that vary between sources; the owner decides)

1. CAGR, Calmar, switches per year and cost drag have no value under one year (`MIN_SPAN_DAYS`), following the GIPS rule against annualizing shorter periods. Today's backtest summary annualizes any span.
2. Statistics of daily returns need `MIN_RETURNS = 20`.
3. Volatility and Sharpe use the sample spread (n - 1), downside deviation and Sortino divide by all `m` returns (Sortino and Price); others use n - 1 or count only the days below target.
4. Downside deviation's default target is the cash return (so it is Sortino's denominator); 0 is the option.
5. Sharpe and Sortino use the arithmetic yearly mean of daily excess returns over the daily cash return, not CAGR minus a yearly rate.
6. Beta and correlation use raw returns (no cash rate needed), not excess returns.
7. VaR and CVaR are daily returns (negative for a loss), from the `ceil(m / 20)`-th worst day without interpolation.
8. Average drawdown is the mean of the episodes' deepest points; longest drawdown and recovery time are in calendar days.
9. Drawdown episodes use the near-tie rule (within 1e-9 of the peak is at the peak); maximum drawdown and the Ulcer index use the exact drawdown.
10. Best and worst year and positive months count complete calendar periods only.
11. Rolling 5-year windows are calendar windows ending at every session, growth per year, target met at `>=`.
12. Average exposure is net weight x leverage, cash 0, over the weights each return period starts from.
13. A wiped-out curve (equity <= 0) gives no metric at all.
14. A spread at or below 1e-12 a day is zero (`noDispersion`).

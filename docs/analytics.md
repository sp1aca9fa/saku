# Analytics

Formulas of the metrics shown with every strategy (requirements 08, "Information-parity metric set"). Code: `packages/core/src/analytics/`. The reference implementation (`packages/reference`) computes the same from this text alone, without reading core; external golden values (testfol, the owner's cases) take precedence over both. The statistics of the robustness lab, the overfitting statistics and the Monte Carlo goal projection (requirements 09) are in "Statistics" below; the robustness score's formula is in `docs/robustness-score.md`.

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
| `averageExposure` | number | `mean(x_0 .. x_(n-2))`, `x_i = sum over the weights at point i of weight x L`: the weights each return period starts from (the last point's weights earn nothing in the series). `L` is the ticker's `L` parameter, read by the one ticker grammar (docs/indicators.md "Synthetic leverage"; `SPY?L=3&E=0.9` is 3; 1 without it; `CASH_USD` is 0; L > 0, so an inverse ticker is malformed). No weights (before the first trade) is 0 | every point `0 .. n-2` has `weights` and every ticker is well-formed in that grammar (`holdingsMissing`); `n >= 2` | |
| `costDrag` | number | `cagr(gross) - cagr(points)`: yearly growth lost to costs (positive = costs cost that much a year) | `gross` given (`grossMissing`); both `cagr` values (their reason otherwise, `equityNotPositive` from `gross` too) | |

Notes:

- **Sample length:** `MIN_RETURNS` and `MIN_SPAN_DAYS` stop meaningless numbers, not noisy ones: 20 days of returns still give a very uncertain Sharpe. The UI shows the period the metrics cover with them.
- **Cost drag source:** the backtest does not return a zero-cost curve; the caller runs it a second time with `costs: {}` (the decisions, and so the trades, are the same). TODO (wiring, with the strategy page): no caller does this yet.
- **Not in this section yet:** tax drag (stage C, after-tax results). The deflated Sharpe ratio and the probability of backtest overfitting are in "Statistics".
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

## Statistics

The contract for both `packages/core` (`packages/core/src/analytics/`) and `packages/reference`: the robustness lab's statistics, the overfitting statistics and the Monte Carlo goal projection (requirements 09). Given the same input and seed, two implementations of this text draw identical random numbers and agree within 1e-9 relative. The robustness score that combines them is not here: its formula waits for approval in `docs/robustness-score.md`.

Notation, `MIN_RETURNS`, `MIN_SPAN_DAYS`, `DISPERSION_FLOOR`, `TIE`, `mean`, `sd`, `days(a, b)` and the Sharpe ratio are those of "Metrics". A statistic is a value or "no value" with a reason, as a metric (`Statistic<T>`), with these reasons: the metric reasons, and `tooFewTrials` (fewer trials than the statistic compares) and `notCovered` (the data does not span the window).

**Near tie** (the near-tie rule, relative): `a` and `b` are tied when `abs(a - b) <= TIE x max(abs(a), abs(b))` (two zeros are tied). A comparison that decides something ("beats", "is the best", a rank) treats tied values as equal, so rounding never flips a result between two implementations.

### Random numbers

One generator, fully specified so core and reference draw the same numbers.

- **Generator:** xoshiro128** (Blackman and Vigna 2018, the reference C code `xoshiro128starstar.c`): state four unsigned 32-bit words `s0..s3`; one output: `result = rotl(s1 x 5, 7) x 9`; `t = s1 << 9`; `s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3; s2 ^= t; s3 = rotl(s3, 11)`. All arithmetic modulo 2^32 (`Math.imul` and `>>> 0` in JavaScript); `rotl(x, k) = (x << k) | (x >>> (32 - k))`.
- **Seeding:** a `seed` and a `stream`, each an integer in `0 .. 2^32 - 1` (`stream` 0 when not given). SplitMix64 (Vigna, `splitmix64.c`) starts from the 64-bit value `x = seed x 2^32 + stream`; each call: `x = x + 0x9E3779B97F4A7C15`; `z = x`; `z = (z ^ (z >> 30)) x 0xBF58476D1CE4E5B9`; `z = (z ^ (z >> 27)) x 0x94D049BB133111EB`; output `z ^ (z >> 31)` (all modulo 2^64, unsigned shifts). Two calls give `z1`, `z2`; `s0 = low32(z1)`, `s1 = high32(z1)`, `s2 = low32(z2)`, `s3 = high32(z2)`. (SplitMix64 is a bijection of its counter, so `z1` and `z2` differ and the state is never all zero.)
- **A float in [0, 1):** two outputs `a` then `b`: `((a >>> 5) x 2^26 + (b >>> 6)) / 2^53` (53 random bits, as MT19937's `genrand_res53`).
- **An integer in [0, n)**, `n` an integer in `1 .. 2^32`: `limit = 2^32 - (2^32 mod n)`; draw outputs until one `x < limit`; return `x mod n` (rejection, no modulo bias).
- **Check values:** SplitMix64 from `x = 0` outputs `0xe220a8397b1dcdaf`, `0x6e789e6aa1b965f4`, `0x06c45d188009454f`. xoshiro128** from the state `(1, 2, 3, 4)` outputs `11520, 0, 5927040, 70819200, 2031721883`. Seeded with `seed = 42, stream = 0` its first outputs are `561131802, 1455960195, 1624807067, 676739556`; with `seed = 42, stream = 7`: `3218433758, 3595279162, 1425948380, 2234227796`. The first float from `seed = 42` is `0.13064867510640732`; the first ten integers in [0, 10): `2, 5, 7, 6, 8, 3, 5, 4, 2, 6`.

### Normal distribution

`Phi(z)`, the standard normal distribution function, and `PhiInv(p)`, its inverse, accurate to 1e-13 relative for `|z| <= 8` and 1e-11 for `|z| <= 37` (`p` in `[1e-300, 1 - 1e-16]`). Any correct method; core: `Phi(z) = erfc(-z / sqrt(2)) / 2`, `erfc` by its Taylor series of `erf` for `|x| < 1` and its continued fraction (modified Lentz) for `|x| >= 1`; `PhiInv` by Newton steps on `Phi` from a bracket, the upper tail computed as `PhiInv(1 - q) = -PhiInv(q)` from `q` (never from the rounded `1 - q`). Check values: `Phi(-1) = 0.15865525393145707`, `Phi(0.3) = 0.6179114221889526`, `PhiInv(0.01) = -2.3263478740408408`, `PhiInv(0.975) = 1.959963984540054`.

### Stationary block bootstrap

Resamples a sample of `n` days (each day one row of every series: the same day for all, so cross-correlation is kept) into a path of `L` days (Politis and Romano 1994):

1. Day 0 of the path: `i = int(n)`.
2. Each next day: `u = float()`; if `u < 1 / meanBlock`, `i = int(n)` (a new block starts at a random day); otherwise `i = (i + 1) mod n` (the block continues; after the last day it wraps to the first, the circular scheme).

Draw order: exactly as written (day 0 draws one integer; each later day one float, then an integer when a block starts). Block lengths are geometric with mean `meanBlock` (a real number `>= 1`; 1 resamples single days, the plain bootstrap).

- **Default `meanBlock = 20` trading days** (about a month): block bootstrap block lengths of order `n^(1/3)` are optimal for variance and distribution estimates (Hall, Horowitz and Jing 1995; Politis and White 2004), and `n^(1/3)` is 15 to 20 for the 12 to 32 years of daily history (3,000 to 8,000 days) the library uses. Volatility clustering lasting longer than a block is only partly kept; a data-driven length (Politis and White 2004, corrected by Patton, Politis and White 2009) is not used, so the length does not depend on the sample.

### Trials (inputs of the overfitting statistics)

A **trial** is one strategy variant tried (a sweep's variants, a family's members); the caller passes every variant tried, not only the kept ones. Input: each trial's equity (`EquitySample[]`, dates strictly ascending, finite) and the `cashReturn` of "Metrics".

- **Aligned excess returns:** the common dates `a_0 .. a_k` (dates every trial has); for trial `j`, `x_(j,i) = e_j(a_i) / e_j(a_(i-1)) - 1 - cashReturn(a_i)` for `i = 1 .. k` (`T = k` rows). Every statistic below uses these rows only (a trial's own longer history is cut to the common dates, so all compare the same days).
- No value: no trial (`tooFewTrials`); any trial's equity `<= 0` (`equityNotPositive`); `T < MIN_RETURNS` (`tooShort`); any `cashReturn(a_i)` unknown (`cashRateMissing`); any trial with `sd(x_j) <= DISPERSION_FLOOR` (`noDispersion`: a trial without swings has no Sharpe and no correlation; it is never dropped, since dropping a tried variant would understate the selection). Checked in this order.
- Per trial, daily (not annualized): `SR_j = mean(x_j) / sd(x_j)` (sample sd, n - 1, as "Metrics"; the yearly Sharpe is `SR_j x sqrt(252)`).

### Effective number of independent trials

`M` trials that are near copies of each other are fewer independent trials. With `rho` the average pairwise correlation: `N = rho + (1 - rho) x M`, a common approximation of the effective number of trials under a constant average correlation. Its source is not yet confirmed (it is not in the abstract of Bailey and Lopez de Prado 2014, "The deflated Sharpe ratio"; owner check C42); the published alternative is clustering similar trials (Lopez de Prado 2018), the number of clusters being N.

- `rho = mean` over all pairs `j < l` of the Pearson correlation of `x_j` and `x_l` (sample covariance over `sd(x_j) sd(x_l)`, each clamped to [-1, 1]), then clamped to [0, 1]: negative correlation never counts as more than `M` independent trials.
- `M = 1`: `N = 1`, `rho` undefined.
- Result: `{ effective: N, trials: M, averageCorrelation: rho | undefined, returns: T }`. `N` is real, `1 <= N <= M`.
- Other sources estimate it from the eigenvalues of the correlation matrix (Nyholt 2004; Li and Ji 2005) or by clustering (Lopez de Prado 2019); not used here.

### Deflated Sharpe ratio

The probability that the selected trial's true Sharpe ratio is above the best one expected from `N` independent trials with no skill (Bailey and Lopez de Prado 2014):

```
DSR = Phi( (SR - SR0) x sqrt(T - 1) / sqrt(1 - g3 x SR + (g4 - 1) / 4 x SR^2) )
SR0 = sqrt(V) x ((1 - gamma) x PhiInv(1 - 1/N) + gamma x PhiInv(1 - 1/(N e)))
```

- `SR`: the selected trial's daily Sharpe (above); `T`: its returns; `g3`, `g4`: skewness and kurtosis of its `x` (not excess kurtosis; a normal distribution has 3), from population central moments `m_k = sum((x - mean(x))^k) / T`: `g3 = m3 / m2^1.5`, `g4 = m4 / m2^2` (as the paper's code, `scipy.stats` with `bias=True`).
- `V`: the sample variance (n - 1) of all `M` trials' daily `SR_j`; `N`: the effective number of trials (above); `gamma = 0.5772156649015329` (Euler-Mascheroni); `e = 2.718281828459045`.
- `SR0`: the expected maximum daily Sharpe of `N` trials without skill. `N = 1` (one trial, or trials that are copies): `SR0 = 0` (no selection; the DSR is then the probabilistic Sharpe ratio against 0). The formula is an approximation for large `N` and turns negative for `N` just above 1 (`N < about 1.3`), where the true expected maximum is still `>= 0`: `SR0` is floored at 0, which keeps the DSR from rising with more trials.
- The denominator's square is never negative for population moments (`g4 >= g3^2 + 1`); at or below `DISPERSION_FLOOR` it is no value (`noDispersion`).
- Result: `{ probability: DSR, sharpe: SR, expectedMaxSharpe: SR0, skewness: g3, kurtosis: g4, returns: T, effectiveTrials: N }`, daily Sharpes (x sqrt(252) for display).
- **Worked example** (the paper's): yearly `SR = 2.5`, `T = 1,250`, `N = 100`, yearly `V = 0.5`, `g3 = -3`, `g4 = 10`, 250 days a year (daily `SR = 2.5 / sqrt(250)`, `V = 0.5 / 250`): `SR0 = 0.1132`, `DSR = 0.9004`.

### Probability of backtest overfitting (CSCV)

Combinatorially symmetric cross-validation (Bailey, Borwein, Lopez de Prado and Zhu 2017), on the aligned excess returns of `M >= 2` trials (`tooFewTrials` otherwise), metric the daily Sharpe:

1. **Blocks:** `S` partitions (`partitions`, even, `>= 2`; default **16**, the paper's example). Block size `b = floor(T / S)`; the first `T - S x b` rows (the oldest) are dropped; block `k` (0-based) is rows `k x b .. (k + 1) x b - 1` of the rest. No value (`tooShort`) when `S / 2 x b < MIN_RETURNS`.
2. **Block sums** per trial `j` and block `k`, summed in row order: `s1 = sum(x)`, `s2 = sum(x^2)`. For a set of blocks, `S1` and `S2` are those sums added in ascending block order; `m` its rows; `mean = S1 / m`; `var = (S2 - S1 x S1 / m) / (m - 1)`; Sharpe `= mean / sqrt(var)`. Any trial with `var <= DISPERSION_FLOOR^2` in any set: no value (`noDispersion`).
3. **Combinations:** every choice of `S / 2` of the `S` blocks, in lexicographic order of the chosen block indices (`C(S, S/2)` of them; 12,870 for 16). The chosen blocks are in-sample (IS), the others out-of-sample (OOS).
4. Per combination: `n*` = the first trial (lowest index) whose IS Sharpe is tied (near tie) with the highest IS Sharpe. Its OOS rank: `r = less + (tied + 1) / 2`, `less` the trials whose OOS Sharpe is below `n*`'s and not tied with it, `tied` those tied with it (`n*` included): the mid-rank, 1 the worst, `M` the best. `w = r / (M + 1)`; logit `lambda = ln(w / (1 - w))`.
5. `PBO = (combinations with lambda <= 0) / C(S, S/2)`: the share of splits where the in-sample best is at or below the out-of-sample median.

Result: `{ pbo, combinations, trials: M, partitions: S, rowsUsed: S x b, rowsDropped }`. `PBO` is in [0, 1]. The paper does not say how ties are ranked; mid-ranks and the near-tie rule are this contract's choice.

### Walk-forward folds

For a strategy with fixed parameters (a registered version or a library variant), "walk-forward" is the test on consecutive periods: no parameter is re-chosen per fold (Pardo's walk-forward analysis re-optimizes on each training window; that is a finder question, not this test).

- **Cut:** `D = days(t_0, t_(n-1))`. Folds `K = min(folds, floor(D / MIN_SPAN_DAYS))` (`folds` default **10**; every fold spans at least a year); `K < 2` is no value (`tooShort`). Boundaries `B_q = t_0 + floor(q x D / K)` calendar days, `q = 0 .. K`. Fold `q` (0-based) holds the points dated `B_q <= t < B_(q+1)`, the last fold also `t_(n-1)`; its series starts with the last point dated before `B_q` (`q > 0`), so each return falls in exactly one fold.
- **Measured per fold:** the Sharpe ratio of "Metrics" (yearly, excess over the cash return) of the strategy's fold series and of the benchmark's, cut by the same boundaries the same way. `beat` = both have a value and the strategy's is higher, not tied (near tie); `undefined` when either has no value.
- Result: `{ folds: [{ start: B_q, end, strategy: Metric, benchmark: Metric, beat }], won, measured }`, `end` the fold's last point's date, `won` the folds beaten, `measured` those with both values.

### Parameter sweep

- **Grid:** a list of parameters, each `{ paths, values }`: `paths` one or more paths into the strategy (keys and array indexes, e.g. `['signals', 0, 'left', 'length']`; several paths take the same value, e.g. one SMA length used in two signals), `values` a non-empty list without repeats. Every path must already exist in the strategy (a typo is refused, never added).
- **Variants:** the Cartesian product in lexicographic order of value indexes, the first parameter outermost and the last varying fastest. Variant index `v = (v_1 .. v_P)`. Each variant is the strategy with each path set to its value, then validated as a strategy (a variant that fails validation is kept with its error, never dropped: it was tried).
- **Evaluation:** the caller's function runs each valid variant (backtest and metrics); the driver returns `[{ index, values, strategy | error, result }]` in variant order.
- **Neighbors** of a variant: the grid points differing by exactly one step (the previous or next value in the list) in exactly one parameter, ordered by parameter, then previous before next.

### Crisis replays

- **Windows** (data, editable; the default list): S&P 500 price index peak-to-trough closes (S&P Dow Jones Indices daily closing levels).

| Id | Start (peak) | End (trough) |
|---|---|---|
| `dotCom` | 2000-03-24 | 2002-10-09 |
| `financialCrisis` | 2007-10-09 | 2009-03-09 |
| `covid` | 2020-02-19 | 2020-03-23 |
| `rates2022` | 2022-01-03 | 2022-10-12 |

- **Per window and series** (strategy, benchmark): covered when the series has a point dated `<= start` and one dated `>= end`, else no value (`notCovered`: data starts later or ends earlier). The window series runs from the last point dated `<= start` to the last dated `<= end`. Reported: `maxDrawdown` (exact running-peak drawdown within the window series, as "Metrics") and `return` (last / first - 1); an equity `<= 0` in the window is `equityNotPositive`.
- `shallower` = both covered and the strategy's `maxDrawdown` is above (less deep than) the benchmark's, not tied (near tie); `undefined` otherwise. Result per window plus `covered` (windows with both values) and `shallower` (their count).

### Monte Carlo goal projection

The probability of reaching an amount by a date with a strategy, from bootstrapped paths of the assets' daily bars (requirements 09).

- **Input:** `history`: raw bars of every series the strategy reads or may hold (the FX rate too, as a series, when the strategy's money is converted), all ending on the same date `h` (the start); `future`: the simulated sessions after `h` (strictly ascending; from the install's calendar; the last is the goal date); `run(bars)`: the caller's strategy run (evaluate, backtest, conversion to the base currency) returning its equity on `h` and every future session; `initial` (amount at `h`'s close, `>= 0`), `monthly` (contribution, `>= 0`), `goal` (`> 0`), all in `currency` (the base currency); `paths` (default **10,000**: the 95% interval below is then at most about 1 percentage point on each side); `meanBlock` (default 20); `seed` (required, recorded with the result); `sampleFrom` (optional first sample date). A malformed input (dates, order, a close or split factor not positive, a field not finite, series ending on different dates, an amount out of range, a seed outside `0 .. 2^32 - 1`, `meanBlock < 1`) is a caller error (throws).
- **Sample days:** a date `d` (`>= sampleFrom`) every series has, where for each series its own previous bar is dated the previous common date (no skipped bar, so no dividend or split is lost). Fewer than 252 sample days (one year of sessions): no value (`tooShort`). For each sample day and series, with `p` the previous bar, `k = 1` when `closeIsSplitAdjusted` else the day's `splitFactor`: relative bar `c = close x k / p.close`, `o`, `hi`, `lo` the same for `open`, `high`, `low` (missing when the field is missing), `y = divCash x k / p.close`.
- **A path** (path `p` uses the generator seeded with `(seed, stream = p)`, so paths can run in parallel and still draw the same): the stationary bootstrap draws `L = future.length` sample days. The series' bars on the future dates are synthesized day by day from the previous close `P` (the last real close at `h`): `open = o x P`, `high = hi x P`, `low = lo x P`, `close = c x P`, `divCash = y x P`, `splitFactor = 1`, `closeIsSplitAdjusted` as the series' last real bar, no volume or adjusted close. The day's total return `(close + divCash) / P - 1` is the sampled day's, and open, high and low keep their ratios to it, so every indicator and the next-open execution run unchanged.
- **Money:** `W_h = initial`; on each future session `f_i`: `W_i = W_(i-1) x e(f_i) / e(f_(i-1)) + C_i`, `e` the run's equity (`f_0 = h`), `C_i = monthly` when `f_i`'s month (`YYYY-MM`) differs from `f_(i-1)`'s (the first session of each new month), else 0. Contributions are invested at that close in the strategy's holdings, without costs. A path whose equity reaches `<= 0` is lost: `W` is 0 from then on and it does not reach the goal. The run's equity at `h` `<= 0`: no value (`equityNotPositive`). A future session missing from the run's output, or an equity that is not a finite number, is a caller error (throws).
- **Output:** `reached` = paths with `W` at the last future session `>= goal` (the value on the goal date, not touching it on the way); `probability = reached / paths`; the Wilson score interval at 95% (Wilson 1927; recommended by Brown, Cai and DasGupta 2001), `z = 1.959963984540054`: `center = (p + z^2 / (2P)) / (1 + z^2 / P)`, `half = z / (1 + z^2 / P) x sqrt(p (1 - p) / P + z^2 / (4 P^2))`, `[center - half, center + half]`, clamped to [0, 1] (rounding). End values at the 5th, 25th, 50th, 75th and 95th percentiles: nearest rank, the `ceil(q x P / 100)`-th smallest (`floor((q x P + 99) / 100)` in integers). Plus `paths`, `sampleDays`, the first and last sample day (`sampleStart`, `sampleEnd`), `meanBlock`, `seed`, `currency`.
- The interval covers only the simulation's randomness. The projection assumes the future resembles the sample (its returns, in blocks of about a month); a sample without a crisis says nothing about one. The UI shows the sample period with it.
- The caller's `run` decides the future cash rate (the backtest needs one for cash and leverage) and any tax; this contract does not.

### Assumed (statistics; the owner decides)

1. The generator is xoshiro128** seeded by SplitMix64 from `(seed, stream)`; floats carry 53 bits; integers by rejection.
2. The bootstrap is the stationary one, mean block 20 trading days, circular, the same days for every series.
3. The overfitting statistics use daily excess returns over the cash rate on the dates every trial has; a trial without swings makes them no value rather than being dropped.
4. The effective number of trials comes from the average pairwise correlation, clamped to [0, 1].
5. The deflated Sharpe ratio floors the expected maximum Sharpe at 0, uses population skewness and kurtosis, and the sample variance of the trials' Sharpes.
6. PBO uses 16 partitions, drops the oldest leftover rows, mid-ranks and the near-tie rule, and counts a logit of exactly 0 as overfit.
7. Walk-forward folds are equal calendar spans of at least a year (at most 10), the strategy fixed, compared with the benchmark on the Sharpe ratio.
8. Crisis windows are the S&P 500's peak-to-trough closes; "shallower" compares the maximum drawdown inside the window.
9. The goal counts the value on the goal date; contributions arrive on each month's first session, without costs; a wiped-out path is lost; the interval is Wilson's at 95%; 10,000 paths.

**Status: Proposal, not approved.** Written 2026-11-01 for the owner's approval (requirements 09 "Robustness score components" and "Score validation"; stage B3). No data was used to write it: every number below is a choice made in advance, marked as such with its reason, and none was tuned. Once approved, the formula is frozen as version 1; any change is a new version logged in this file with its reason.

# Robustness score (proposal)

## What it is

One number from 0 to 100 per strategy version: how far its backtested edge over the benchmark can be trusted. 50 is the benchmark's own level. It is shown with its five components, the weakest one named, and next to the deflated Sharpe ratio and the probability of backtest overfitting (09), which stay separate. It is not a forecast of returns.

## Common definitions

- **D1. Backtest.** The engine's backtest of the version (`next_open`, the version's costs, `CASH_USD` at the rate known through `asOf`). The **scored period** runs from the version's first evaluated date (every held ticker has a bar, warm-up done) to the last final trading date. History before a leveraged fund existed: as decided for library Q1 (`docs/strategy-library.md`).
- **D2. Currency and tax.** USD, after costs, before tax (choice, R1). Reason: tax depends on the user's lots, account and regime, and the score asks whether the signal's edge is real; after-tax results are shown in the metrics and used by the finder (09).
- **D3. Benchmark.** SPY total return bought on the first day of the scored period and held, no costs, over the same dates (choice, R6). Reason: the only benchmark in Tier 0; the tier benchmarks of requirements 01 (All Country, the 8-asset fund) need Tier 1 data (C2) and replace it per tier then.
- **D4. Excess return.** Each day's return minus that day's cash return (the USD rate through `asOf`, per night, as the engine applies it). An unknown rate stays unknown: a component that needs a day with an unknown rate is "insufficient data", never computed with 0%.
- **D5. Risk-adjusted measure M.** With annualized mean excess return E (daily mean x 252) and annualized volatility V (daily sample standard deviation x sqrt(252)): M = E / V when E >= 0, and M = E x V when E < 0 (Israelsen 2005, to verify: that this refinement ranks negative-excess cases correctly). Reason: with a plain Sharpe ratio, of two strategies that lose the same, the more volatile one looks better. M equals the Sharpe ratio when E >= 0, is only used to rank, and is never displayed as a Sharpe ratio. V = 0 with E = 0 (cash only) gives M = 0; V = 0 otherwise is "insufficient data".
- **D6. Beats and ties.** A beats B when M_A > M_B. A near-tie (within 1e-9 relative, the numerics rule; two zeros are a tie) counts as half a win, so a strategy identical to the benchmark scores exactly half.
- **D7. Randomness.** Every random draw uses a generator seeded from SHA-256 of the version's hash and the component's name. Results are reproducible and recorded with the seed.
- **D8. Data health.** The score shows the number of yellow and red days in its input series over the scored period. When red days are more than 0.5% of the scored days, the score is "insufficient data (data health)" (choice, R8: about one red day a year over 30 years is 0.4%; beyond that the history is doubtful).

## Components

Each maps to 0-100. P, T, C and S compare the strategy with the benchmark, so the benchmark against itself gets 50 on each (D6). L compares the strategy with its own backtest.

### P. Parameter stability: does it only work at one setting?

- **Perturbed:** every indicator `length`, every non-zero `threshold` level and every non-zero `tolerancePct`. Not perturbed (structural): a level of 0, a tolerance of 0, ensemble shares, weights, tickers, leverage and expense of synthetic tickers, operators. An operand that appears more than once (the same indicator, ticker, length, method and series) is perturbed once, so it stays the same everywhere it appears.
- **Neighbors:** 100 settings; each perturbed value is multiplied by its own factor drawn uniformly from [0.8, 1.2], then lengths are rounded to the nearest integer at or above the schema's minimum and levels and tolerances to 2 decimals. A draw equal to the original or to an earlier neighbor is drawn again (at most 1,000 draws in all).
- **Measure:** each neighbor's full backtest against the benchmark over that neighbor's own evaluated dates. **P = 100 x (wins + ties / 2) / neighbors.**
- **Minimum:** 20 distinct neighbors; otherwise "not applicable" (too few parameters), shown as such and left out of the aggregate.
- **Display:** "82 of 100 nearby settings also beat the S&P 500 after adjusting for risk".
- **Choices:** +/-20% (a 200-day average against 160-240 days is what a reader would call nearby; wide enough to expose a sharp peak, narrow enough to stay the same idea). 100 neighbors (the share's standard error is at most 5 points). Joint perturbation of all parameters (one at a time misses interactions). Uniform factors (the simplest).

### T. Time stability: does it work across periods?

- **Folds:** consecutive blocks of 756 trading days (about 3 years), counted back from the scored period's last date; the remainder at the start is not scored. Each fold is a slice of one continuous backtest: holdings carry into the fold, nothing is reset or re-optimized (a registered version's parameters are fixed; see R3).
- **Measure:** strategy against benchmark over each fold's dates. **T = 100 x (wins + ties / 2) / folds.**
- **Minimum:** 5 folds (15 years); otherwise "insufficient data".
- **Display:** "Beat the S&P 500 in 7 of 10 three-year periods".
- **Choices:** 3 years (long enough to hold a full trend cycle in most periods and a stable M; gives about 10 periods over 30 years, as in requirements 09's example). At least 5 (with fewer, one period moves T by 25 points or more).

### C. Crisis survival: does it protect when it matters?

- **Crises (fixed now from the S&P 500 index's well-known peak and trough closes, to verify against stored data; never adjusted to a strategy):**

| Crisis | From | To |
|---|---|---|
| 2000-02 | 2000-03-24 | 2002-10-09 |
| 2008 | 2007-10-09 | 2009-03-09 |
| 2020 | 2020-02-19 | 2020-03-23 |
| 2022 | 2022-01-03 | 2022-10-12 |

- **Covered** when the strategy is evaluated on the window's first date and every date through its last. Uncovered crises are listed with the reason ("UPRO data starts 2009").
- **Measure:** the largest drawdown inside the window, from the highest value reached since the window's first date, for the strategy and the benchmark. Passed when the strategy's drawdown is no deeper than the benchmark's (a near-tie is half). **C = 100 x (passed + ties / 2) / covered.**
- **Minimum:** 2 covered crises; otherwise "insufficient data".
- **Display:** "Lost less than the S&P 500 in 3 of 4 crises (2000-02 not covered: data starts 2009)".
- **Choices and limits:** the index's own peak and trough (objective, set before any strategy is scored); each crisis weighs the same; pass or fail as in requirements 09's display. Only the fall is measured, not a missed rebound (T sees that). 2020 is about 23 trading days, so `next_open` lag weighs heavily there.

### S. Statistical confidence: could it be luck?

- **Edge:** D = M_strategy - M_benchmark over the scored period.
- **Bootstrap:** stationary bootstrap (Politis and Romano 1994, to verify: that resampling blocks of random, geometrically distributed length keeps the series' dependence and gives a stationary resampled series) with mean block length 63 trading days. Each day's strategy return, benchmark return and cash rate are resampled together. 10,000 replicates of the scored period's length; each gives D\*.
- **p-value (one-sided, centered):** p = (1 + number of replicates with D\* - D >= D) / (10,000 + 1). When D and every D\* are near-ties (the strategy is the benchmark), p = 0.5.
- **Trials:** p_adj = 1 - (1 - p)^N_eff (Šidák), with N_eff the effective number of independent trials below. **S = 100 x (1 - p_adj).**
- **Minimum:** 1,260 scored days (5 years, about 20 mean blocks); otherwise "insufficient data".
- **Display:** "Results this good would appear 6% of the time with no edge, counting about 9 independent strategies tried" (p_adj and N_eff).
- **Also shown, not used:** S with mean block lengths 21 and 126, so the reader sees how much the choice matters.
- **Choices:** 63 days (about a quarter: keeps volatility clustering and the multi-week holding periods of trend strategies inside blocks). 10,000 replicates (p resolution 0.0001; simulation error near p = 0.05 about 0.002). Centered, not studentized (R7: simpler to implement identically twice; Ledoit and Wolf 2008, to verify: a studentized block bootstrap for the difference of two Sharpe ratios, is more accurate and the alternative). Šidák (matches the idea of independent trials).
- **Consequence to know:** with a library of about 60 variants, a strategy needs a clearly significant edge to keep S near 50 or above. That is intended: the more is tried, the less any one result proves.

### Effective number of independent trials (N_eff)

- **Trial set.** A library variant: every registered library variant, plus the owner's documented earlier trials (`docs/evidence/backtests.md`: 5 configurations, a lower bound, since unrecorded tries are unknown). A user's strategy: the library set plus the user's registered versions (drafts are not recorded, so it is a lower bound, labeled). The set and its size are stored with each score.
- **Estimate.** Over the dates all trials share, the mean pairwise correlation r of their daily excess returns (negative r counted as 0): **N_eff = r + (1 - r) x n**, from 1 (identical) to n (uncorrelated). With fewer than 1,260 shared dates, N_eff = n.
- **Choice and reason (R4):** simple and conservative: for highly correlated trials it overstates the selection effect rather than understating it (an eigenvalue-based count would give a smaller number). Clustering (Bailey and López de Prado 2014) is the refined alternative.
- Adding variants raises N_eff, so stored scores are recomputed as annotations with the date and set used; earlier values are kept.

### L. Live decay: does it still work after registration?

- **Forward returns:** the forward record's daily results since registration, as signaled (safe-state days included), with costs; excess over cash (D4).
- **Reference:** the stationary bootstrap (mean block 63) of the pre-registration backtest's daily (strategy, cash) pairs gives 10,000 paths as long as the forward record; M of each.
- **Measure:** q = share of paths with M below the forward M (a near-tie is half). **L = min(100, 200 x q):** at or above the backtest's median gives 100; the bottom quarter maps to 0-50.
- **Minimum:** 126 forward trading days (6 months, as the finder's eligibility); otherwise "not enough live data yet (N of 126 days)" and left out.
- **Display:** "Live results in line with the backtest" (q >= 0.25), "below the backtest" (0.05 <= q < 0.25), "well below the backtest" (q < 0.05).
- **Role:** L only lowers the score (it enters the weakest-link cap, not the mean; R2). Reason: matching one's own backtest is no reason for a higher score, and a lucky live start must not lift it.

## Aggregation

Let A be the available components among P, T, C and S, and W the smallest of A and L (when available):

- **G = geometric mean of A**, each component floored at 1 for this mean only (a single 0 would otherwise erase the others; the cap below already punishes it).
- **Score = min(G, W + 15)**, rounded to the nearest integer (halves up).

Why: a geometric mean is never below its smallest part, so "capped by the weakest component" read literally would be the minimum alone. The cap of the weakest + 15 lets the others count while one weak component keeps the score down: a component at 30 limits the score to 45, below the benchmark (choice, R2).

**Benchmark calibration.** The benchmark against itself: P not applicable (no parameters), T = C = 50 (ties), S = 50 (p = 0.5, N_eff = 1), no L. G = 50 and W + 15 = 65, so the score is 50 by construction.

## Insufficient data

| Part | Minimum | Otherwise |
|---|---|---|
| P | 20 distinct neighbors | Not applicable, left out |
| T | 5 folds of 756 days | Insufficient data |
| C | 2 covered crises | Insufficient data |
| S | 1,260 scored days | Insufficient data |
| L | 126 forward days | Not enough live data, left out |
| Any | Cash rate known on every needed day (D4); red days at most 0.5% (D8) | Insufficient data, with the reason |

**The overall score is shown only when S and T are available and at least 3 of P, T, C and S are.** Otherwise it reads "Insufficient data" and names what is missing (for example "history 9 years; 15 needed for time stability"). The components that do exist are still shown.

## Known-answer tests (requirements 09)

Run on the design period only (from the first stored date through 2016-12-31; see the validation below), before the predictive check.

1. **Random entry, median <= 35.** 200 random strategies: each day the holding switches between SPY and `CASH_USD` with probability 4/252 (about 4 switches a year, a typical count for a trend filter; choice), the start state from the seed, `next_open`, 5 bps slippage. P's parameter is the switch probability (neighbors with new seeds). N_eff = 1 each (one person trying one random rule).
2. **Deliberately over-optimized, <= 40 each.** For three structures, 1,000 random parameter sets (fixed seed); the one with the best M on the design period is scored, with those 1,000 as its trials. Leverage is synthetic (`SPY?L=2&E=0.9`, `SPY?L=3&E=0.9`) so the period covers 2000-02 and 2008. Ranges (deliberately wide, to invite overfitting):
   - trend and calm: SMA length 20-400; tolerance 0-10%; volatility length 5-120; volatility level 10-50; risk-on leverage 1, 2 or 3; trend-only leverage 0 (cash), 1 or 2.
   - absolute momentum: three return lookbacks 5-300 days; ensemble share 1/3, 2/3 or 1; leverage 1, 2 or 3; fallback cash.
   - volatility steps: volatility length 5-120; target 5-40.
3. **Benchmark, 45-55.** SPY against itself. It is 50 by construction, so this test checks the implementation, not the formula's merit.

**If a known-answer test fails:** the failure is recorded here and reported to the owner. A revision is a new formula version with a reason that is not the test result itself (a bug, a wrong definition); constants are never stepped until a test passes. After 2 revisions the owner decides. The predictive check runs only after all three pass.

## Pre-registered validation (predictive check)

- **Periods, named before any run.** Design period: the first stored date through 2016-12-31. **Held-out period: 2017-01-03 (the first trading day of 2017) through 2026-10-30.** Nothing in the formula or in the known-answer tests may read held-out data. The run waits until the held-out data passes its checks (data health).
- **Disclosure.** The formula's author used no data. The owner has seen 1996-2026 results for one family (`docs/evidence/backtests.md`), and the library's families were chosen with general knowledge of market history up to 2026. To keep that knowledge out, the check uses a mechanically generated population, not the library.
- **Population (seed: SHA-256 of `saku-robustness-validation-1`).** For each family 1-11 of the library, 30 parameter sets, each numeric parameter of the family's first variant multiplied by its own factor drawn uniformly from [0.5, 2] (lengths rounded): 330. Plus the 200 random-entry strategies and the 3 over-optimized ones: 533 in all. Leverage is synthetic (`SPY?L=...`, `QQQ?L=...`, E = 0.9). The trial set for S is the whole population.
- **Score:** each strategy scored on design-period data only (no L).
- **Outcome:** each strategy's M minus the benchmark's M over the held-out period, with indicators and holdings carried in from the design period (no look-ahead).
- **Primary hypothesis:** the Spearman rank correlation rho between score and outcome is positive. Test: stationary bootstrap of held-out dates (mean block 63, 10,000 replicates), all strategies' days resampled together; one-sided p = share of replicates with rho\* - rho >= rho. **Pass: rho > 0 and p < 0.05.** Strategies with "insufficient data" are left out and counted.
- **Reported, not pass or fail:** mean outcome of the top fifth by score against the bottom fifth; the known-answer tests on held-out data; the count left out.
- **Run once,** as one server job, with the code commit, the data snapshot's hash and the seed written below before it starts. The result is written below whatever it is.
- **If it fails:** the score is shown labeled "not validated" and the finder's eligibility rule "robustness score >= 60" is not applied until a revised formula passes (R5). A revision is logged here with its reason and validated only on data after 2026-10-30.
- **Known limit:** one 10-year path, largely a bull market with two short crashes; defensive strategies may trail there whatever their robustness, so the check has little power. A negative result is still recorded as it is.

## Numbers that are choices

| Number | Where | Reason (summary) |
|---|---|---|
| +/-20%, 100 neighbors, at least 20 | P | Nearby; 5-point precision; enough to judge |
| 756 days, at least 5 folds | T | About 3 years; one fold must not move T by 25+ points |
| Four crisis windows, at least 2 | C | Index peak to trough, fixed in advance |
| Mean block 63 days, 10,000 replicates | S, L, validation | Keeps dependence; small simulation error |
| 1,260 days | S, N_eff | 5 years, about 20 blocks |
| N_eff = r + (1 - r) x n | S | Conservative |
| 126 forward days; 200 x q; wording at 0.25 and 0.05 | L | The finder's 6 months; median or better is no penalty |
| Weakest + 15; floor 1 | Aggregation | One weak component keeps the score below 50 |
| 0.5% red days | D8 | About one a year over 30 years |
| 4/252, 200 strategies | Known-answer 1 | Typical trend-filter switching |
| Held-out 2017-01-03 to 2026-10-30 | Validation | About 10 years, includes 2018, 2020 and 2022 stress |
| [0.5, 2], 30 per family | Validation | A wide population around each family |

## Open questions for the owner

- **R1.** Score in USD before tax (D2). Alternative: in the base currency after tax, which differs per install and per account. Recommendation: before tax; after-tax shown beside it.
- **R2.** Reading "geometric mean, capped by the weakest component" as min(G, weakest + 15), with live decay only in the cap. Recommendation: yes.
- **R3.** Time stability as fixed-parameter three-year periods. Requirements 09 say "walk-forward folds"; for a fixed version there is nothing to re-fit, and the finder's self-test covers the selection process. Recommendation: yes.
- **R4.** The conservative N_eff estimate. Recommendation: yes; revisit with clustering at TR3.
- **R5.** If the predictive check fails: score labeled "not validated" and not used by the finder's eligibility. Recommendation: yes.
- **R6.** S&P 500 as the benchmark for every tier until Tier 1 data exists. Recommendation: yes.
- **R7.** Centered bootstrap instead of the studentized one of Ledoit and Wolf (2008). Recommendation: centered for v1, the studentized one as a later version validated on new data.
- **R8.** The 0.5% red-day limit (D8). Recommendation: yes, after C22-C25 settle the old red days.

## References (all to verify)

- Bailey, David H., and Marcos López de Prado (2014). "The Deflated Sharpe Ratio: Correcting for Selection Bias, Backtest Overfitting, and Non-Normality." _The Journal of Portfolio Management_ 40(5). Claim: the best Sharpe ratio among many trials must be deflated for the number of trials, and the number of independent trials can be estimated by clustering.
- Bailey, David H., Jonathan M. Borwein, Marcos López de Prado, and Qiji Jim Zhu (2017). "The Probability of Backtest Overfitting." _Journal of Computational Finance_ 20(4). Claim: combinatorially symmetric cross-validation estimates how often the in-sample best is below median out of sample (shown beside the score, 09).
- Israelsen, Craig L. (2005). "A Refinement to the Sharpe Ratio and Information Ratio." _Journal of Asset Management_ 5(6). Claim: as in D5.
- Ledoit, Oliver, and Michael Wolf (2008). "Robust Performance Hypothesis Testing with the Sharpe Ratio." _Journal of Empirical Finance_ 15(5). Claim: as in S.
- Politis, Dimitris N., and Joseph P. Romano (1994). "The Stationary Bootstrap." _Journal of the American Statistical Association_ 89(428). Claim: as in S.
- Šidák, Zbyněk (1967). "Rectangular Confidence Regions for the Means of Multivariate Normal Distributions." _Journal of the American Statistical Association_ 62(318). Claim: the adjustment 1 - (1 - p)^n for n independent tests.

## Validation record

Not run. Known-answer tests: not run. Predictive check: not run.

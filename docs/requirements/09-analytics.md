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


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


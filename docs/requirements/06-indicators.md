# 06. Indicators and numeric rules

All computed locally from verified data, each with documented formula, parameters and warm-up period (`docs/indicators.md` and tooltips, EN/JA).

- **v1:** Price, SMA, EMA, Return over N days, Volatility (close-to-close, sqrt(252)), Parkinson, Garman-Klass and Yang-Zhang volatility, Drawdown from N-day or all-time high, N-day High/Low, Threshold; tolerance bands on any comparison.
- **v1.1:** RSI, MACD, Bollinger Bands, ATR, moving-average slope, relative strength, rolling correlation.
- **Tier 2 (F2):** credit spread level and change, yield curve, NFCI, unemployment trend (Sahm-style), VIX, T-bill rate.

## Numeric rules
- float64 for prices, returns and indicators; decimal.js for money, tax and quotas.
- **Near-ties:** when a compared value is within 1e-9 (relative) of its reference, the comparison is a tie and the previous state is kept. Core and reference implementations apply the same rule; tie days are logged and are not treated as mismatches.
- Annualization uses 252 trading days.


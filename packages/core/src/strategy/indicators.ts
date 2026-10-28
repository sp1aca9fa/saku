// Indicators (requirements 06) over one ticker's daily series, one value per bar; `undefined`
// during the warm-up. Formulas are documented in docs/indicators.md.

/**
 * Simple moving average of the last `length` values (warm-up: length - 1 bars). Each value is
 * summed from its own window, so a longer history never changes it (incremental = full).
 */
export function sma(values: number[], length: number): (number | undefined)[] {
  return values.map((_, i) =>
    i < length - 1
      ? undefined
      : values.slice(i - length + 1, i + 1).reduce((a, b) => a + b, 0) / length,
  );
}

/**
 * Close-to-close volatility in percent, annualized with 252 days: the sample standard deviation
 * (n - 1) of the last `length` simple daily returns, times sqrt(252), times 100. Warm-up: `length`
 * bars (it needs length + 1 values).
 */
export function volatility(values: number[], length: number): (number | undefined)[] {
  const returns = values.map((v, i) => (i === 0 ? NaN : v / values[i - 1]! - 1));
  return values.map((_, i) => {
    if (i < length) return undefined;
    const window = returns.slice(i - length + 1, i + 1);
    const mean = window.reduce((a, b) => a + b, 0) / length;
    const variance = window.reduce((a, r) => a + (r - mean) ** 2, 0) / (length - 1);
    return Math.sqrt(variance) * Math.sqrt(252) * 100;
  });
}

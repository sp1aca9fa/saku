# testfol parity

External golden values for the backtest engine (requirements 13, "testfol parity"; 05, execution).
Saku backtests each case the owner exported from testfol on the server's stored data and compares
the summary stats. A misread rule that core and the reference implementation share shows up here
as a red layer E result. Code: `packages/plugin-sdk/src/jobs/parity.ts`; it runs in `pnpm verify`
and the weekly run.

Summary stats may be kept in this public file. Daily equity curves and saved testfol pages stay in
the private `plugins/` submodule.

## A case

A folder `plugins/test/testfol/<case>/` (private) holding `case.json`:

```json
{
  "strategy": {
    "name": "Example trend",
    "account": "taxable",
    "execution": "same_close",
    "safeState": { "holdings": [{ "ticker": "CASH_USD", "weight": 100 }] },
    "evaluation": { "frequency": "daily" },
    "signals": [
      {
        "id": "trend",
        "type": "compare",
        "left": { "indicator": "price", "ticker": "SPY" },
        "op": ">",
        "right": { "indicator": "sma", "ticker": "SPY", "length": 200 },
        "tolerancePct": 3
      }
    ],
    "allocations": [
      { "name": "Risk on", "when": { "all": ["trend"] }, "holdings": [{ "ticker": "SPY?L=3", "weight": 100 }] },
      { "name": "Cash", "holdings": [{ "ticker": "CASH_USD", "weight": 100 }] }
    ]
  },
  "from": "1994-01-25",
  "to": "2026-10-28",
  "stats": { "cagr": 0.1532, "maxDrawdown": -0.4211, "switches": 57 }
}
```

(The numbers above are made up.) JSON until a YAML parser is approved; the folder layout is the
one the requirements name.

Rules, each checked; a case that breaks one is refused (red, "cannot run", with the reason):
- `strategy`: a valid Saku strategy with `"execution": "same_close"` written out (testfol's timing;
  an omitted execution means `next_open`). Same-close trading is not achievable in practice: it
  trades at a close that is not yet known. It exists only for this comparison.
- Real tickers only: SPY, not SPYSIM (any ticker ending in `SIM` is refused). Synthetic leverage
  (`SPY?L=3&E=0.9`) is allowed.
- `from`: the first day of testfol's results, on or after 1993-02-01. Every ticker the case reads
  must have stored bars on or before `from`, and `from` must be Saku's first decision day (the
  warm-up covered by stored data); a later first decision refuses the case.
- `to`: the last day of testfol's results; a trading day with stored bars (Saku must decide on it).
- `stats.cagr`: a fraction (0.1532 for 15.32%). `stats.maxDrawdown`: a negative fraction (-0.4211
  for a 42.11% drawdown). `stats.switches`: required, a whole number (requirements 13 sets a
  tolerance for it, so a case without it would overstate parity).
- No other keys (a misspelled key is refused, not ignored).

## Exporting a case from testfol

Unverified until the first real case: these steps and where testfol shows each number.

1. Build the strategy in testfol's tactical allocation backtest with SPY (not SPYSIM), a start date
   on or after 1993-02-01, and testfol's default (same-close) timing.
2. Run it and save the page (or a screenshot) in `plugins/ops/` (private).
3. Note from the results: the first and last date of the results, CAGR, max drawdown, and the
   number of switches from the Trading Stats tab. testfol's definition of a switch is unverified
   until the first real case (Saku's is below).
4. Write the same strategy as Saku strategy JSON (check it with `pnpm strategy check <file>`),
   add `"execution": "same_close"`, and save `plugins/test/testfol/<case>/case.json` as above.
5. Run `pnpm verify` on the server. The log shows one `Layer E testfol_parity` line per case.

## How Saku computes the case

- Decisions from the whole stored history up to `to`: indicators and tolerance bands warm up on
  data before `from`.
- The equity curve from `from` (which must be the first decision day) to `to`, trading at each
  decision's close (`same_close`), starting at 1.
- CAGR over calendar time (365.25-day years) from the first to the last day of the curve; max
  drawdown on daily closes; a switch is any change of the holdings list after the first entry (a
  ticker, a weight, or their order: two allocations listing the same holdings in another order
  count as a switch even though nothing is traded).
  Synthetic leverage uses the
  requirements 05 formula (daily return = L * r - (L - 1) * cash rate / 252 - E / 100 / 252, the
  cash rate as known before each session).
- Data health from each ticker's first stored bar through `to`, by each stored bar's latest
  grade. Warm-up days count: they feed the indicators, and band state carries from the first
  decision, so a bad day before `from` can change the curve. A red or ungraded day, or a session
  without a stored bar, for any ticker the case reads refuses the case (the message names the
  ticker, the count and the first date). Yellow days are computed and counted in the message; the
  status still follows the tolerances. The cash rate's own health is not checked here.
- Every stored result starts with the label `same_close (not achievable)`.

## Tolerances (requirements 13, never widened)

| Stat | Tolerance |
|---|---|
| CAGR | +/- 0.3 percentage points (absolute) |
| Max drawdown | +/- 1.0 percentage points (absolute) |
| Switches | +/- 5% of testfol's count, at least 1 switch |

A case is green when every stat is within its tolerance, red otherwise or when it cannot run.
Every case is stored in full each run (green included: ours, testfol's, the difference and the
window). A red case fails the run and alerts the admins; it stays red until the cause is found and
recorded below. The stored deviation is the worst |difference| / tolerance over the stats (above 1
is outside).

## Results

| Case | Period | Stat | testfol | Saku | Difference | Status | Date |
|---|---|---|---|---|---|---|---|

## Known differences

Each difference found, its cause and whether it is accepted (a documented testfol convention) or a
Saku bug (fixed). Still to check on the first real case: testfol's financing and expense defaults
for `?L=`, and whether testfol warms indicators up on data before its start date the way Saku does.

| Case | Difference | Cause | Decision | Date |
|---|---|---|---|---|

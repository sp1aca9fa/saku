# Data pipeline

How data gets from the sources into Saku and how it is checked. Requirements: `docs/requirements/04-data-pipeline.md`. Status: Stage A1 (ingestion, adjusted series, layers A-C). Severity rules, the stand-in rule and health status come with A2; issuer data (layer D), the quota guard, the weekly refetch and the fault-injection suite with A3.

## Flow

1. **Hourly check** (`saku-daily.timer`, :20): `pnpm probe`, then `pnpm daily`.
2. **Daily job**, once per trading day: the target date is the latest NYSE session past 20:00 New York time (`SAKU_DAILY_AFTER`). Already stamped: exit.
3. **Ingest** (`plugin-sdk/jobs/ingest.ts`): every bar source in turn, for every active symbol, the last 10 sessions up to the target; then series (FRED `DTB3`, `SP500`) and FX (`USD` + base currency) from every source that supports the pair.
4. **Store** (`db/market.ts`): see Storage below.
5. **Verify** (`plugin-sdk/jobs/verify.ts`): canonical bars from the primary with our adjusted series; layers A-C; results stored.
6. **Backup**, then the stamp and the healthchecks.io ping, only when every source answered for every item.

`pnpm bootstrap` fetches full history (from each symbol's inception, within each plan's history limit) and checks it; `pnpm checks` reruns the checks over full history.

A source that refuses (403, 429, a challenge page) or would pass 80% of a declared limit stops for the run; any other failure is recorded for that item and the run goes on. A source whose key is missing is skipped. Either way the run is incomplete: no stamp, no ping, retried at the next check.

## Sources and roles

| Data | Primary | Secondary | Notes |
|---|---|---|---|
| Daily bars | Tiingo | Alpaca (from 2016), Massive (2 years), Yahoo (private, full history) | Roles seeded from the plug-ins' suggestions once per data kind; the admin decides |
| Series | FRED (`DTB3`, `SP500`) | | Every vintage kept (ALFRED real-time periods) |
| FX | ECB (USD/base as a cross of two euro rates) | FRED H.10, Yahoo | Valuation rates; tax rates come with C1 |
| Calendars | NYSE, Federal Reserve, TARGET | | Versioned tables from the `calendars` plug-in |

## Storage

- **Raw bars** (`bars_raw`): every bar as each source sent it, keyed by symbol, date and source. Never deleted. A changed raw field (open, high, low, close, split-adjusted flag, volume, dividend, split) is logged in `bar_revisions` (old, new, when, run) before the row is updated. A date a source stops returning is kept and reported.
- **Provider adjusted closes** keep the latest snapshot. A rewrite of past values (after a dividend or split) is one `readjustments` event per factor (consecutive dates with the same ratio within 1e-9), not one revision per day.
- **Series and FX** keep every vintage: a value is stored only when it is new for its date and publication time. `known_at` is the publication time (FRED's vintage date; ECB's 16:00 Frankfurt), or the fetch time when the source gives none. `asOf` (A2) reads `known_at`.
- **Canonical bars** (`bars`): the primary's values with our adjusted series, rebuilt by each verification run (they are derived; the raw data and its revisions are the record).

## Our adjusted series

A forward-accumulated total-return index, 1.0 on the first date:

    r(t) = (close(t) + dividend(t)) * split(t) / close(t-1) - 1,   index(t) = index(t-1) * (1 + r(t))

where `split(t)` is the new-for-old share ratio effective on t (2 for a 2-for-1 split) and the dividend is per share going ex on t. A later dividend never changes earlier values, so incremental and full recomputation agree exactly. Assumption: when a split and a dividend share a date, the dividend is per new share.

## Checks

Every check gives one result per date (green ones too), stored with the source compared. Daily runs store every result in their 10-session window; full-history runs store one summary per check (count, passed, largest deviation in the check's unit) and every non-green result.

| Layer | Check | Rule | Tolerance | Status |
|---|---|---|---|---|
| A | `bar_valid` | prices > 0; high >= max(open, close); low <= min(open, close); volume, dividend >= 0; split > 0; a trading day | | red on failure |
| A | `missing_day` | every NYSE session between a source's first and last bar has a bar | | red for the primary, yellow for others |
| A | `large_move` | daily total return | 25% at 1x, 60% at 3x, linear between (2x: 42.5%) | yellow (a flag) |
| A | `unchanged_close` | same close as the previous session, no split | | yellow (a flag) |
| B | `close_match` | secondary close (un-split) vs primary close; a missing secondary bar is yellow | 0.05% relative | green / <= 2x yellow / red |
| B | `dividend_match`, `split_match` | events on the same dates; amounts | 1% relative | an event on one side only is red |
| B | `adj_return_match` | daily return of our series vs a provider's adjusted closes (every source that has them, the primary included) | 0.02pp | green / <= 2x yellow / red |
| B | `fx_match` | secondary FX rate vs primary | 0.5% relative | green / <= 2x yellow / red |
| C | `leverage_track` | fund total return vs leverage x underlying's price return | 0.5pp + 10% of the expected move | green / <= 3x yellow / red; outside 3 days in a row: red |
| C | `index_match` | fund price return vs its index's return (`symbols.index_series`; SPY: FRED `SP500`, last 10 years) | 0.1pp | green / <= 3x yellow / red |

Notes and assumptions:
- **Un-splitting:** a split-adjusted source (Yahoo: prices, volume and dividends on today's share basis) is restated as traded using its own split events: a value on date D is multiplied by every split after D (volume divided). A wrong split in that source shows up as a layer B mismatch.
- **Layer B starts where the secondary's history starts** (Alpaca 2016, Massive 2 years): a plan's limit is not a missing bar.
- **Layer C on ex-dividend days:** a leveraged fund tracks its index, whose level excludes dividends, so the expected move uses the underlying's price return; the fund's own distributions are in its total return. Daily financing costs (about 0.02-0.04% a day) sit well inside the tolerance.
- **Move flags for 2x funds** are interpolated (42.5%); the requirements name 1x and 3x only.
- **`unchanged_close`** flags a close equal to the previous session's (two days with the same close).
- Gate counting (`pnpm spike`): a day's "pass" is all of its results for that layer green.

## Attribution

Shown on the app's data sources page (with the UI, D1; the text goes through `packages/content`):
- FRED: "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis."
- ECB: "Exchange rates: European Central Bank. USD/base-currency rates are derived as a cross of two euro reference rates."

## A1 measurement

- `pnpm probe` logs, every hour, the last sessions of one ticker from every bar source (`~/.local/state/saku/probe.jsonl`). For each source and date: when the bar first appeared and when its values last changed. That sets the daily run time (default 20:00 New York until measured).
- `pnpm spike` prints the pre-registered gate per day from each date's latest daily run (`docs/requirements/stages/stage-a.md`).

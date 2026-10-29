# Data pipeline

How data gets from the sources into Saku and how it is checked. Requirements: `docs/requirements/04-data-pipeline.md`. Status: Stage A1 (ingestion, adjusted series, layers A-C) and the first A2 parts (health status, the stand-in rule; the decision-margin test comes with the strategy engine); the fault-injection suite (A3); issuer data (layer D), the weekly refetch and the CSV fallback follow in A3.

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
- **Series and FX** keep every vintage: a value is stored only when it is new for its date and publication time. `known_at` is the publication time as UTC ISO text, or the fetch time when the source gives none; a publication date without a time of day is refused (read as midnight it would make a value known hours early). FRED gives only the vintage day: assumption, known from 18:00 New York that day (the H.15 and H.10 releases come out in the afternoon). ECB: 16:00 Frankfurt. `asOf` (A2) reads `known_at`.
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

## Data health

Each run grades every symbol and trading day (`data_health`, and `bars.status` on the canonical bar), and the day overall:
- **Per symbol:** the worst of its check results that day (any source, any layer); a day only one source had a bar is at least yellow (`single_source`); a day with neither a primary bar nor a stand-in is red (`primary_missing`). Reasons are codes such as `B.close_match@alpaca`.
- **Overall:** the worst symbol, the FX checks and the cash series' freshness on the run's date; the reasons name the symbols that were not green and the FX checks that failed.
- **Cash series freshness** (the series a source declares as the USD cash rate, FRED's `DTB3`, on the Federal Reserve's business days): the latest value known at the run may miss only the run's own day (FRED publishes the next business day), green; 2-5 business days behind is yellow (`DTB3:stale(3)@fred`); more, no value, or no source declaring a cash rate (`cash:missing@none`), red. An unknown rate is never taken as 0%: the forward record's equity is then unknown (null) on days that need it. It grades the day overall but no symbol, so it does not apply a strategy's safe state (the rate moves the equity of cash and synthetic leverage, not the signal).
- Daily runs store every row in their window; full-history passes store the non-green rows.

Assumption: a failed check of a secondary also counts (a layer A failure or a mismatch above 2x tolerance is red whichever source looks wrong), since the two sources disagreeing means neither can be trusted alone.

## Stand-ins (primary missing, secondary present)

For a session the primary has no bar (from its first bar to the target date), a secondary's bar stands in when:
1. it passes layer A (structure, no move or unchanged-close flag) that day;
2. when two or more secondaries have a valid bar, they agree within the close tolerance (0.05%); the first in role order is used;
3. it passes layer C where it applies: against the underlying's canonical bars (themselves possibly stand-ins), and against the fund's index;
4. the primary has been missing at most 2 sessions in a row (the 3rd and later are refused).

A stand-in day is yellow (`stand_in@<source>`); a refused one red (`stand_in_refused:<reason>`). Each stand-in records its **band** for the decision-margin test (A2, with the strategy engine): the close tolerance when two secondaries agreed, else the index tolerance (0.1pp) when the index check passed, else the layer C tolerance of that day; with no independent check at all (a 1x fund without an index, one secondary, or the day after a gap), the layer C base tolerance (0.5pp), recorded with basis `unchecked`. Assumption: that last case is not named in the requirements.

Stand-ins are kept in `stand_ins`. When the primary's bar arrives, the canonical bar is rebuilt from it and the stand-in row gets the primary's close and the difference; a difference above the close tolerance is logged (the alert and the forward-record annotation come with A2's alerts and records).

## Fault injection (layer F)

`packages/plugin-sdk/src/jobs/faults.test.ts` runs in CI on synthetic data: a clean bootstrap, then a whole daily run (ingest, checks, forward record, alerts) with one material fault in one source's response, all sources available (a primary and two secondaries, one sending adjusted closes). A clean run is green (the control). Each case asserts the grade, the check that caught it (a reason on the strategy's record) and, on red, the safe state in the record and the alert:

| Fault | Injected into | Grade | Caught by |
|---|---|---|---|
| Decimal shift (close x10) | primary; a secondary | red, safe state | B close |
| Missed split | primary; a secondary | red, safe state | B split |
| Split applied to prices but not declared | primary | red, safe state | B split |
| Missed dividend | primary; a secondary | red, safe state | B dividend |
| Dividend x10 | primary | red, safe state | B dividend |
| A provider's adjusted close off by 1% | the adjusted secondary | red, safe state | B adjusted return |
| Stale close (previous close repeated) | primary; a secondary | red, safe state | B close |
| Swapped tickers | primary | red, safe state | B close |
| Timezone shift, each bar a session late | primary | red, safe state | B close |
| Timezone shift, each bar a session early (the target day is missing) | primary | red, safe state | the 2x fund's stand-in refused (layer C) |
| Missing day; the same day sent twice (the response is refused, the run incomplete) | primary | yellow (`stand_in`) | A missing day, the stand-in rule |
| Cash rate a week stale | the cash series | red for the day overall, admin alert; the strategy's own grade stays green (by design, above) | series freshness |

A day only one source had is never green (`single_source`, yellow). New data paths add their cases here.

Open (owner decision): a strategy's grade reads only the target day's bars. When a source corrupts recent days (as the early timezone shift does), those days are red on their own dates, but a signal whose lookback reads them is graded on the target day alone; in that case the 2x fund's refused stand-in made it red, a 1x-only strategy would have been yellow.

## Attribution

Shown on the app's data sources page (with the UI, D1; the text goes through `packages/content`):
- FRED: "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis."
- ECB: "Exchange rates: European Central Bank. USD/base-currency rates are derived as a cross of two euro reference rates."

## A1 measurement

- `pnpm probe` logs, every hour, the last sessions of one ticker from every bar source (`~/.local/state/saku/probe.jsonl`). For each source and date: when the bar first appeared and when its values last changed. That sets the daily run time (default 20:00 New York until measured).
- `pnpm spike` prints the pre-registered gate per day from each date's latest daily run (`docs/requirements/stages/stage-a.md`).

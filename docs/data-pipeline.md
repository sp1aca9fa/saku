# Data pipeline

How data gets from the sources into Saku and how it is checked. Requirements: `docs/requirements/04-data-pipeline.md`. Status: Stage A1 (ingestion, adjusted series, layers A-C) and the first A2 parts (health status, the stand-in rule; the decision-margin test comes with the strategy engine); the fault-injection suite, the weekly run and layer E on stored data (A3); source roles and the CSV fallback (A3); issuer data (layer D, advisory) in A3.

## Flow

1. **Hourly check** (`saku-daily.timer`, :20): `pnpm probe`, then `pnpm daily`.
2. **Daily job**, once per trading day: the target date is the latest NYSE session past 20:00 New York time (`SAKU_DAILY_AFTER`). Already stamped: exit.
3. **Ingest** (`plugin-sdk/jobs/ingest.ts`): every bar source in turn, for every active symbol, the last 10 sessions up to the target; then series (FRED `DTB3`, `SP500`) and FX (`USD` + base currency) from every source that supports the pair; then issuer data (layer D) from every issuer source with a role, for each active symbol it supports.
4. **Store** (`db/market.ts`): see Storage below.
5. **Verify** (`plugin-sdk/jobs/verify.ts`): canonical bars from the primary with our adjusted series; layers A-D; results stored.
6. **Backup**, then the stamp and the healthchecks.io ping, only when every source answered for every item (issuer sources aside: best effort, below).

`pnpm bootstrap` fetches full history (from each symbol's inception, within each plan's history limit) and checks it; `pnpm checks` reruns the checks over full history.

A source that refuses (403, 429, a challenge page) or would pass 80% of a declared limit stops for the run; any other failure is recorded for that item and the run goes on. A source whose key is missing is skipped. Either way the run is incomplete: no stamp, no ping, retried at the next check.

## Sources and roles

| Data | Primary | Secondary | Notes |
|---|---|---|---|
| Daily bars | Tiingo | Alpaca (from 2016), Massive (2 years), Yahoo (private, full history) | Roles seeded from the plug-ins' suggestions once per data kind; the admin decides |
| Series | FRED (`DTB3`, `SP500`) | | Every vintage kept (ALFRED real-time periods; fetched in windows of at most 1000 vintages, see `docs/data-spike.md`). A series FRED keeps no vintages for (`SP500`): current values, known from the fetch time |
| FX | ECB (USD/base as a cross of two euro rates) | FRED H.10, Yahoo | Valuation rates; tax rates come with C1 |
| Calendars | NYSE, Federal Reserve, TARGET | | Versioned tables from the `calendars` plug-in |

## Storage

- **Raw bars** (`bars_raw`): every bar as each source sent it, keyed by symbol, date and source. Never deleted. A changed raw field (open, high, low, close, split-adjusted flag, volume, dividend, split) is logged in `bar_revisions` (old, new, when, run) before the row is updated. A date a source stops returning is kept and reported.
- **Provider adjusted closes** keep the latest snapshot. A rewrite of past values (after a dividend or split) is one `readjustments` event per factor (consecutive dates with the same ratio within 1e-9), not one revision per day.
- **Series and FX** keep every vintage: a value is stored only when it is new for its date and publication time. `known_at` is the publication time as UTC ISO text, or the fetch time when the source gives none; a publication date without a time of day is refused (read as midnight it would make a value known hours early). FRED gives only the vintage day: assumption, known from 18:00 New York that day (the H.15 and H.10 releases come out in the afternoon). ECB: 16:00 Frankfurt. `asOf` (A2) reads `known_at`.
- **Issuer records** (`issuer_records`): NAV with its currency, distribution and split per symbol, issuer source and date. A row is added only when the values for that date differ from the latest stored (a vintage, never an overwrite); reads take the latest. A response with a date twice, a value that is not a number or a NAV without an ISO 4217 currency is refused whole. For checks only: never a value used in calculations.
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
| B | `fx_unavailable` | on a graded date from the primary's first rate on, the secondary has a rate and the primary none (as known at the run), so the cross-check cannot run (04 severity rules: an FX cross-check unavailable); not on a day the primary's declared calendar is closed (an expected gap); with no primary rate at all, the run's date | | yellow; the day overall only |
| C | `leverage_track` | fund total return vs leverage x underlying's price return | 0.5pp + 10% of the expected move | green / <= 3x yellow / red; outside 3 days in a row: red |
| C | `index_match` | fund price return vs its index's return (`symbols.index_series`; SPY: FRED `SP500`, last 10 years) | 0.1pp | green / <= 3x yellow / red |
| C | `index_unavailable` | from the index's first value on, a fund date whose return cannot be compared because the index lacks a value (that day or the one before); with no index value at all (or no series primary), the run's date | | yellow |

Notes and assumptions:
- **Un-splitting:** a split-adjusted source (Yahoo: prices, volume and dividends on today's share basis) is restated as traded using its own split events: a value on date D is multiplied by every split after D (volume divided). A wrong split in that source shows up as a layer B mismatch.
- **Layer B starts where the secondary's history starts** (Alpaca 2016, Massive 2 years): a plan's limit is not a missing bar.
- **Layer C on ex-dividend days:** a leveraged fund tracks its index, whose level excludes dividends, so the expected move uses the underlying's price return; the fund's own distributions are in its total return. Daily financing costs (about 0.02-0.04% a day) sit well inside the tolerance.
- **Move flags for 2x funds** are interpolated (42.5%); the requirements name 1x and 3x only.
- **`unchanged_close`** flags a close equal to the previous session's (two days with the same close).
- **Index gaps** (`index_unavailable`): a check that could not run is never green (04: an unexpected gap of a point-in-time series is yellow; a cross-check unavailable is yellow). Before the index's first value is the provider's history limit (FRED: 10 years), not a gap, as layer B starts where a secondary starts. Index and FX values are read as known at the run (point in time, `known_at` up to the run's clock): a value published later is neither compared nor counted as fresh, also in the stand-in rule's index check. One exception, the publication lag as for the cash rate: on the run's own date the index may lack only that day's value (it has the day before); that comparison is left to the next daily run, whose 10-session window covers the date again. Assumption: `SP500`'s value for a day may not be published by the run; the requirements do not say when FRED publishes it.
- **Gate counting** (`pnpm spike`): every NYSE session from the target of the earliest daily run of any status (or `from`; a run that crashed still marks the start) through the daily target (the CLI passes it; else the latest target of a finished run) counts, from the calendar, not only the sessions that had a run. Runs start with their target recorded, so a run that never finishes still names its date. Only daily runs that finished (success or failed) and stored check results for the date count. The primary and layer B are read from the latest such run targeting the date; a secondary is available when any such run targeting the date got its bars (stage-a A1: availability per day). A run that finished as failed (incomplete, for example a secondary down) counts by what it stored, so a secondary's outage is measured as secondary availability, not as a primary failure. Layer C passes when the day's own run's layer C results (what was decided on) are all green and the index results for the date from the latest such run whose window (10 sessions before its target through the target) covers it are all green: the next run's index check for the date counts, and a failure at decision time is never dropped by a later correction (both runs' non-green results are listed, each with its run). A fund with an index and no index result for the date is not passed; it is pending while no later finished run covering the date has stored results for it. A session without a run is failed everywhere (`no run`: primary failed, no secondary available, layers B and C not passed), except the daily target while its run has not finished: pending. The verdict covers the sessions before the first pending one ("passed through <date>" or "not passed"); the sessions from the first pending one on are listed, never counted as passed, and do not block the verdict on the earlier ones. A day's "pass" for a layer is all of its results for that layer green.

## Issuer reconciliation (layer D)

Requirements 04: market close vs issuer NAV within the fund's normal premium/discount, and distributions and splits matching the issuer's records; best effort, a check and not a gate. Issuer sites publish files, not official APIs, so issuer plug-ins (`IssuerSource`) are private; none is public. An issuer plug-in's roles are under the data kind `issuer` (`pnpm sources set issuer <key> check`); a source without a role is neither fetched nor checked.

- **What a plug-in returns** (`IssuerRecord`): one record per date, values as published for that date: the NAV per share on that day's share basis with its currency (ISO 4217; a NAV without one is refused), never adjusted for later splits or distributions (an adjusted history reads as a premium on every day before the event); on an ex-date the distribution per share (all distributions going ex that day summed) and the split ratio (2 for 2-for-1).
- **Fetching:** each issuer source with a role, for every active symbol it `supports`, in the daily window (10 sessions) or the full history like the other sources. A failure does **not** make the run incomplete (it would stop the heartbeat on every flaky issuer site). It is logged, graded and told: the day overall is yellow `issuer_unavailable@<source>` (04 severity rules: an issuer site unavailable is yellow; the admins get the data-health alert), and each fund it failed for is graded by its staleness below. A `supports` that throws counts every fund as supported (none is left out). A source with a role whose plug-in is not loaded (the private package absent or failed to load) is logged and graded the same way: the day `issuer_unavailable@<source>`, and every fund it has records for a yellow `issuer_stale` whatever their age.
- **Checks** (`packages/data/src/issuer.ts`), for each symbol and each issuer source with a role, one result per check and date:

| Check | Rule | Tolerance | Status |
|---|---|---|---|
| `nav_premium` | \|close / NAV - 1\|, the primary's close (as traded) vs the issuer's NAV on the same date; a NAV not positive, or in another (or no) currency than the fund's, is a mismatch and never a premium | the fund's `issuer_nav_tolerance`; none set: green, the deviation recorded (observed only) | green / <= 2x yellow / red, capped |
| `distribution_match`, `split_match` | the issuer's events vs the primary's on the same dates, within the dates both cover (the issuer's first to last record). A source that publishes NAV is compared only on dates it has a record: a primary event on a date it has none is "not compared" (yellow, issuer data unavailable), never "event missing in issuer data". A source without NAV (events only) reports every event in its range, so a date without its record reads as no event | 1% relative (layer B's event tolerance) | an event on one side only is a mismatch; capped |
| `issuer_stale` | on the run's date, the latest NAV more than 1 session behind. With no NAV stored for the fund: yellow when this run's fetch failed for it, or when the source supports it and has stored nothing (a source that delivered NAV-less records is events-only and has no freshness) | 1 session | yellow |
| `nav_tolerance_invalid` | the stored `issuer_nav_tolerance` does not parse (only a hand edit can do that): premiums are observed only, and the day overall gets `issuer_nav_tolerance_invalid` (admins told); the run goes on | | yellow |

- **Advisory cap:** every layer D result is at most yellow (`LAYER_D_MAX_STATUS`) until the owner has set each fund's tolerance from observed data and decides that layer D may turn a day red (a decisions-log entry). So layer D warns, never applies a safe state. Results feed the symbol's health like the other layers (reasons such as `D.nav_premium@<source>`).
- **Setting** `issuer_nav_tolerance`: a JSON map of ticker to a fraction, each above 0 and at most 0.2 (20%; wider would not catch a decimal error), e.g. `pnpm settings set issuer_nav_tolerance '{"<TICKER>":0.005}'` (the whole map each time). Keys naming no active symbol are warned about when set, in every run's log and by the stats command.
- **Stats** to set it from: `pnpm sources issuer-stats [--years N]` (default 2) prints, per fund and issuer source with stored records, the days with both a primary close and a NAV in the fund's currency over the last N years, the median, 99th percentile (linear interpolation between ranks) and largest \|close / NAV - 1\|, how many days were left out (stand-in closes, days graded red: not trusted primary values) and the tolerance set.

## Data health

Each run grades every symbol and trading day (`data_health`, and `bars.status` on the canonical bar), and the day overall:
- **Per symbol:** the worst of its check results that day (any source, any layer); a day only one source had a bar is at least yellow (`single_source`); a day with neither a primary bar nor a stand-in is red (`primary_missing`). A symbol the primary has no bar for at all (a new primary without its history) is red `primary_missing` too, from its first canonical bar, else its inception date (within the run's window), else on the run's date only (its stored canonical bars on those dates get that status; their values stay); it is never left out of the day. Reasons are codes such as `B.close_match@alpaca`.
- **Overall:** the worst symbol, the FX checks and, on the run's date, the freshness of the cash series, each graded fund's index series and the base-currency FX pair; the reasons name the symbols that were not green, the FX checks that failed and the series that are behind.
- **Cash series freshness** (the series a source declares as the USD cash rate, FRED's `DTB3`, on the Federal Reserve's business days): the latest value known at the run may miss only the run's own day (FRED publishes the next business day), green; 2-5 business days behind is yellow (`DTB3:stale(3)@fred`); more, no value, or no source declaring a cash rate (`cash:missing@none`), red. An unknown rate is never taken as 0%: the forward record's equity is then unknown (null) on days that need it. It grades the day overall but no symbol, so it does not apply a strategy's safe state (the rate moves the equity of cash and synthetic leverage, not the signal).
- **Index series freshness** (each active fund's `index_series` from the series primary, read through `asOf` on the run's date, on the trading calendar since the index is compared on the fund's sessions): the same rule (`SP500:stale(3)@fred`; no value or no series primary `<series>:missing@<source or none>`, red). It grades the day overall only, like the cash rate: a stale index alone never applies a strategy's safe state, since the bars themselves are checked by layers A and B. The fund still learns of the gap through its own `index_unavailable` results (yellow).
- **FX freshness** (base currency other than USD; the `USD<base>` valuation pair from the FX primary, read through `asOf` on the run's date, on the trading calendar): the same rule (`USDJPY:stale(3)@ecb`; no FX primary: `USD<base>:missing@none`, red). Where the primary lacks a rate a secondary has, the cross-check is a yellow `fx_unavailable` (table above). FX grades the day overall only, never a symbol or a strategy (04: FX health never affects a signal computed in USD). **Expected gaps:** a series or FX plug-in may declare the calendar it publishes on (`PluginInfo.calendar`, the id of a loaded calendar plug-in; ECB: `ecb-target`, closed 1 January, Good Friday, Easter Monday, 1 May, 25 and 26 December); a missing primary rate on a day that calendar is closed is green (04: known holidays of the series' calendar), not `fx_unavailable`. A declared calendar that is not loaded is warned about in the run's log and counts no day as closed. Freshness is still counted on the trading calendar: a TARGET-only holiday reads one session behind, still green.
- Daily runs store every row in their window. Full-history passes store the non-green symbol rows, each symbol's graded date range (`health_coverage`) and the overall row of every date they graded, green included, in that order: a missing symbol row is green only inside that symbol's range, on a date with the overall row. Check results are stored as "Storage of results" says (requirements 04).
- **Report** (`pnpm health [--date <YYYY-MM-DD>] [--days <N>] [--lang <code>]`, read-only; default the last 5 trading days up to the latest graded date): per date the overall grade and each symbol not green, with the reasons in words, as the latest finished run covering the date graded it. Only runs that stored something count (one that failed before storing anything does not hide older grades). A daily run covers 10 sessions before its target through the target; no row = not graded. A bootstrap, weekly or checks run covers every date through its target; no overall row = not graded, and a missing symbol row = green only inside that symbol's `health_coverage` range for the run (and not when one of the run's non-green check results for that symbol and day lacks its row). Full passes from before `health_coverage` read "not graded" for those symbols until the next one. Series freshness (cash rate, index, FX) is graded only on a run's own date: for an earlier date, the freshness reasons and the FX cross-checks that could not run (`fx_unavailable`) of the latest run that targeted it are merged into the overall grade, so a day graded for them never reads green later. A symbol before its first canonical bar is left out unless its inception date is on or before the date (then not graded). A date or symbol nobody graded is "not graded", never green. The header names the latest run (type, target, status, error, heartbeat). Exit code 0 only when every shown date is green overall and for every symbol.

Assumption: a failed check of a secondary also counts (a layer A failure or a mismatch above 2x tolerance is red whichever source looks wrong), since the two sources disagreeing means neither can be trusted alone.

## Stand-ins (primary missing, secondary present)

For a session the primary has no bar (from its first bar to the target date), a secondary's bar stands in when:
1. it passes layer A (structure, no move or unchanged-close flag) that day;
2. when two or more secondaries have a valid bar, they agree within the close tolerance (0.05%); the first in role order is used;
3. it passes layer C where it applies: against the underlying's canonical bars (themselves possibly stand-ins), and against the fund's index;
4. the primary has been missing at most 2 sessions in a row (the 3rd and later are refused).

A stand-in day is yellow (`stand_in@<source>`); a refused one red (`stand_in_refused:<reason>`). Each stand-in records its **band** for the decision-margin test (A2, with the strategy engine): the close tolerance when two secondaries agreed, else the index tolerance (0.1pp) when the index check passed, else the layer C tolerance of that day; with no independent check at all (a 1x fund without an index, one secondary, or the day after a gap), the layer C base tolerance (0.5pp), recorded with basis `unchecked`. Assumption: that last case is not named in the requirements.

Stand-ins are kept in `stand_ins`. When the primary's bar arrives, the canonical bar is rebuilt from it and the stand-in row gets the primary's close and the difference; a difference above the close tolerance is logged (the alert and the forward-record annotation come with A2's alerts and records).

## Source roles and the CSV fallback

- **Roles** are seeded from the plug-ins' suggestions on the first run of each data kind (one primary). After that the admin decides: `pnpm sources list` (roles in order, and loaded plug-ins that have none), `pnpm sources set <bars|series|fx|issuer> <key> <primary|secondary|check>` (a new primary turns the old one into a secondary), `pnpm sources remove <kind> <key>` (its stored data stays). The primary is never demoted or removed by itself: name its successor first, so each data kind keeps exactly one. A source without a role is neither fetched from nor checked. Role changes and imports are refused while a job runs (try again after it). Every run logs loaded plug-ins without a role. Each change is in the activity log. The Settings page replaces this with D1.
- **CSV fallback** (`pnpm csv import <file> --ticker SPY --prices raw|split-adjusted [--source csv-<name>]`): columns `date,open,high,low,close,volume,dividend,split` (only `date` and `close` required; dividend 0 and split 1 when empty). The admin states whether the prices are as traded or split-adjusted (many exports give split-adjusted closes); split-adjusted ones are put back on the traded basis with the file's own split column, like any split-adjusted source. Validated before anything is stored: plain decimal numbers, `YYYY-MM-DD` trading days inside the calendar, in order, each once, and layer A's structure checks on every bar (missing trading days in the file's range are listed as a warning, since a fallback may cover some days only); unknown columns (an adjusted close, for example) refuse the file, since derived values are never imported. One bad row refuses the whole file. The bars are stored as raw data of their own source (`csv` by default, never a plug-in's key) through the revision log, and are used once that source has a role, like any source: as a secondary to cross-check, or as the primary while the main source is down (then `pnpm sources set bars <main> primary` again). The next run's checks grade them.

## Fault injection (layer F)

`packages/plugin-sdk/src/jobs/faults.test.ts` runs in CI on synthetic data: a clean bootstrap, then a whole daily run (ingest, checks, forward record, alerts) with one material fault in one source's response, all sources available (a primary and two secondaries, one sending adjusted closes). A clean run is green (the control), also with clean issuer data and with a clean FX primary and secondary; SPY's index check runs in every case (the index is published the evening after, so the target day's index check is left to the next run). An FX primary without a rate on a day its declared calendar is closed stays green; on an undeclared day that day is yellow (`fx_unavailable`). Each case asserts the grade, the check that caught it (a reason on the strategy's record) and, on red, the safe state in the record and the alert:

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
| Issuer NAV off by 10% (tolerance set); a distribution missing in the issuer's data; the issuer down for days; the issuer refusing every request from the bootstrap on (nothing stored) | the issuer source | yellow, the normal signal kept (layer D is advisory); the run complete; a source that could not be fetched is told to the admins | D `nav_premium`, `distribution_match`, `issuer_stale` |
| Cash rate a week stale | the cash series | red for the day overall, admin alert; the strategy's own grade stays green (by design, above) | series freshness |
| Index source down for days (3 sessions behind, every call failing) | the index series | yellow, the normal signal kept; the run incomplete; admins told | C `index_unavailable`, index freshness |
| FX primary down, 3 sessions behind; a week behind (base JPY) | the FX primary | the day yellow; red; the strategy's own grade stays green (FX never affects a USD signal); the run incomplete; admins told | FX freshness, B `fx_unavailable` |

A day only one source had is never green (`single_source`, yellow). New data paths add their cases here.

Open (owner decision): a strategy's grade reads only the target day's bars. When a source corrupts recent days (as the early timezone shift does), those days are red on their own dates, but a signal whose lookback reads them is graded on the target day alone; in that case the 2x fund's refused stand-in made it red, a 1x-only strategy would have been yellow.

## Weekly run and `pnpm verify` (layers E and G)

- **`pnpm weekly`** (Sundays, `saku-weekly.timer`): refetches the full history from every source. Changed raw values go to the revision log (`bar_revisions`, old and new value) and the admins get one summary per run (ticker, field, source, count, dates), after the recompute of every recorded day (differences annotated and told, as in the daily run). A checked backup is made first. Then the checks over the full history, a data-health alert if the day turned non-green, and layer E.
- **`pnpm verify`** (any time, no fetching; `pnpm checks` is the same): layers A-D over the full history and layer E.
- **Layer E** (`jobs/integrity.ts`), for each registered version over today's canonical bars of what it reads: core vs the reference implementation (same days, signals and allocations; equity within 1e-9 relative), and incremental vs full (the latest 20 decision days and one every 250 back, each decided and valued from the bars up to that day only, against the full pass: no look-ahead and no state that depends on later data). Stored as layer E check results (summary per check, red ones in full); a red one fails the run and alerts the admins.
- Series and FX values a refetch changes are kept as new vintages (point in time, never overwritten) and counted per source in the run log; the summary to the admins covers bars.
- **testfol parity** (`jobs/parity.ts`, layer E check `testfol_parity`): each case in `plugins/test/testfol/<case>/case.json` is backtested on the stored canonical bars (`same_close`, decisions from the whole stored history up to `to`, the curve from `from`, which must be the first decision day) and its CAGR, max drawdown and switches compared with testfol's within the requirements' tolerances. A red, ungraded or missing day of a ticker it reads in the window refuses the case; yellow days are counted. One result per case, stored in full (green included) and alerted like the other layer E results; no cases folder means no results (a log line). Case format, tolerances and known differences: `docs/parity.md`.

## Attribution

Shown on the app's data sources page (with the UI, D1; the text goes through `packages/content`):
- FRED: "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis."
- ECB: "Exchange rates: European Central Bank. USD/base-currency rates are derived as a cross of two euro reference rates."

## A1 measurement

- `pnpm probe` logs, every hour, the last sessions of one ticker from every bar source (`~/.local/state/saku/probe.jsonl`). For each source and date: when the bar first appeared and when its values last changed. That sets the daily run time (default 20:00 New York until measured).
- `pnpm spike` prints the pre-registered gate per day from each date's latest daily run (`docs/requirements/stages/stage-a.md`).

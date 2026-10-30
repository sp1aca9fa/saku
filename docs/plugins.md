# Writing a plug-in

Anything particular to one provider, country or broker is a plug-in, never core code (requirements
`docs/requirements/15-plugins.md`). Plug-ins return data; core validates it before anything is
stored. A plug-in never writes to the database.

## Public and private

| Folder | For |
|---|---|
| `plugins-public/` | Plug-ins for official APIs, with neutral names, and the template |
| `plugins/` | Your own plug-ins, usually a private git repo mounted as a submodule (unofficial, scraped or personal sources go only here) |

Each folder is a package whose `src/index.ts` exports one array per kind it has. A missing folder
is skipped, so the public repo builds, tests and runs without `plugins/`. Real recorded provider
responses go only in the private repo; public fixtures are synthetic.

## Kinds and methods

Types are in `packages/plugin-sdk/src/types.ts`. A package exports `bars`, `series`, `fx`,
`issuers`, `calendars` and `notifiers` (any subset).

| Export | Interface | Methods |
|---|---|---|
| `bars` | `BarSource` | `fetchBars(ticker, from, to, ctx)` returns raw daily bars (`RawBar[]`); optional `fetchMeta(ticker, ctx)` returns `TickerMeta` |
| `series` | `SeriesSource` | `fetchSeries(id, from, to, ctx)` returns dated points (`SeriesPoint[]`): cash rates, index levels |
| `fx` | `FxSource` | `supports(pair)`; `fetchRates(pair, from, to, ctx)` returns `FxRate[]` |
| `issuers` | `IssuerSource` | `supports(ticker)`; `fetchRecords(ticker, from, to, ctx)` returns NAV, distributions and splits (checks only, never a value used) |
| `calendars` | `CalendarSource` | a `calendars` array of exchange or series holiday tables |
| `notifiers` | `Notifier` | `validTarget(target)`; `send(target, text, ctx)`. Errors must not contain the target or the key |

Dates are `YYYY-MM-DD` trading dates. Return raw values as the provider gives them (provider
adjusted values only in the fields meant for checks); never compute indicators or derived series.
A missing field stays missing, it never becomes a zero.

Series and FX sources that keep vintages: when the source revises a value to "no value" (a later
vintage of the date is empty), return a withdrawal for that date and vintage,
`{ date, withdrawn: true, publishedAt }` (`SeriesWithdrawal`; for FX `{ pair, date, withdrawn:
true, publishedAt }`), never a zero. From its publication time (or, without one, the fetch) on,
point-in-time reads treat the date as having no value; a later value for the date restores it.
Send one only for a date the source had a value for; a date that never had one is left out.
Every series point and FX rate is either a withdrawal (`withdrawn: true`, no value) or a finite
number; anything else (a null, missing or NaN value without `withdrawn: true`, or a withdrawal
with a value) refuses the whole response, nothing stored. So do two different vintages (two
values, or a value and a withdrawal) for the same date and publication moment (the same instant
in any spelling, `Z` or an offset); the same vintage twice is stored once.

### `PluginInfo`

Every source has an `info` (`NotifierInfo` for notifiers) that describes it. Each job run saves
the descriptions to the database. The fields:

- `key`: stored with every row it provides; never change it once data exists.
- `kind`, `name`, `provides` (tickers, series, pairs, markets, `cashRates` per currency).
- `suggestedRole`: used the first time; you decide afterwards with `pnpm sources` (see
  `docs/running.md`).
- `limits`: the provider's requests per minute, hour and day, and symbols per month.
- `provider` (optional, default the key): the provider whose limits the requests count against.
  Plug-ins of one provider (its bars and its FX, two plug-ins on one key) declare the same
  `provider` and the same `limits`; loading refuses a set where they differ. Their requests then
  share one count: in a run their clients are paced together, and across runs the usage is
  stored under the provider id. Usage a plug-in stored under its key before it declared the
  provider still counts (loaded with the provider's); new usage goes under the provider id only.
  Same form as a key; keep it once usage is stored (changing one provider id to another starts
  without the old id's history). Notifier keys share this namespace: a notifier whose key equals
  a data provider id counts with it, so it must not equal one unless their limits match.
- `keyEnv`: the environment variable(s) holding the key, read from `.env`.
- `termsUrl`: the provider's terms.
- `noAi`: the terms forbid giving its data to AI models (left out of MCP and AI exports).
  `noAiItems` marks single tickers, series or pairs.
- `unofficial`: not an official API.
- `history`: how far back the plan reaches. `calendar`: the days it publishes on, so a gap on a
  closed day is expected.
- `adjCloseRounding` (bar sources sending adjusted closes): their relative rounding, how far two
  fetches' ratios of one real re-adjustment can differ. A change within it is stored without a
  re-adjustment event. Default 1e-9 (double precision), at most 1e-5. State the provider's
  precision it rests on next to the value, and check it with `pnpm sources readjustments`.
- `publishes` (issuer sources): what their records hold, `{ nav?: true, distributions?: true,
  splits?: true }`, at least one. Layer D compares only the declared kinds: a NAV-only file
  declares `{ nav: true }` and its missing distributions are never read as mismatches; values of
  an undeclared kind are ignored. Not declared: inferred from the records (NAV when any record
  has one; distributions and splits always compared), so declare it whenever you know. If what
  the files hold differs per fund, leave it out.

### The context

`ctx` has `http` (the SDK client), `now`, `log`, `apiKey` (the first `keyEnv`) and `keys`. In a
job run it also has `finalAfter`: the New York time (`HH:MM`, `SAKU_DAILY_AFTER`, default 20:00)
from which a session's data counts as final, the same as for the daily target. Return only final
data within the asked range; a later run's window covers the date.

## The HTTP client

- Never call `fetch` directly. Use `ctx.http` (`json`, `text`, `bytes`, `post`).
- It keeps to 80% of each declared limit, waiting when it can and stopping with a quota error
  when the wait would be too long.
- It retries server errors and timeouts with backoff.
- It stops that source for the run on 403, 429 or a captcha or challenge page, and never works
  around a block: a 429 or a challenge page stops every source of that provider for the run,
  since a sibling sending on would work around it; a 403 stops only the source it was answered
  to (it can refuse one endpoint or plan). A 4xx error carries a short excerpt of the provider's
  reason.
- Keys and tokens in URLs are masked in errors and logs. Prefer sending a key in a header.
- Sources run one after another, each with its own client. The clients of one provider
  (`provider`) share one count of requests and symbols, so together they stay under 80%. A
  notifier's channels share their service's count, but a refusal stops only the channel it was
  answered to.

## Start from the template

`plugins-public/template/` holds a runnable bar source for a made-up provider, with fixtures and a
test (see its `README.md`). The template is not loaded by the jobs. A tax regime template comes
with the tax stage; none exists yet.

1. Copy `plugins-public/template/` to a new folder (in `plugins/` for a private plug-in, with
   its own `package.json`, `tsconfig.json` and `src/index.ts`; see how `plugins-public/` is set up).
2. Rename the source, set its `key`, `info` and limits from the provider's terms.
3. Replace the fixtures with the provider's answers saved as files, and map them in the source.
4. Export it from `src/index.ts`.

## Testing on fixtures

Use `fixtureContext` from `@saku/plugin-sdk/testing`: a context whose HTTP client answers from
saved files and never touches the network. It records the URLs, headers and bodies requested, so a
test can check that the key is not in the URL. The template test shows the pattern: the mapping to
raw bars, key handling, and failing loudly when an answer changes shape. Run with `pnpm test`
(the `plugins/` package is tested when it is checked out). No test makes a live call.

## Checklist before turning a source on

1. The provider's terms are checked (`termsUrl` is right), including whether its data may go to
   AI models: set `noAi` when not.
2. Official API, or `unofficial: true` and the plug-in in the private repo.
3. `limits` match the plan you have, and the key variable is in `.env`.
4. Tests on fixtures pass (`pnpm test`), and `pnpm typecheck`.
5. `pnpm plugins` loads it (lists `<kind> <key>`). A plug-in added after the first run has no role
   and is neither fetched nor checked until you assign one (`pnpm sources list` shows it).
6. One real run looks right: run `pnpm bootstrap` or `pnpm daily` on the server and compare a few
   values with the provider's site.
7. Its role starts as secondary or check (`pnpm sources set <kind> <key> secondary`) until its
   numbers agree with the primary in the data-health checks.

# 15. Plug-ins

## Rule of thumb
If something is particular to one country, provider, broker, site or person's usage, it is a plug-in or an admin setting, never core code. If a plug-in could serve others as an example and uses an official API, it can go public with neutral names. Anything unofficial, scraped or personal stays private.

## Kinds
Contracts are typed interfaces in `packages/plugin-sdk`. A plug-in package exports one array per kind from `src/index.ts` and may export only the kinds it has.

| Kind | Provides | Stage |
|---|---|---|
| `BarSource` | Daily bars (raw fields, provider adjusted values for checks), ticker metadata | A1 |
| `SeriesSource` | Dated series: cash rates, index levels, later macro series | A1 (F2 for macro) |
| `FxSource` | Daily exchange rates for valuation | A1 |
| `TaxFxSource` | Broker-style rates for tax (TTM/TTS/TTB or the regime's equivalent) | C1 |
| `IssuerSource` | NAV, distributions, splits from fund issuers | A3 |
| `EventCalendarSource` | Scheduled market events | F1 |
| `TaxRegime` | A country's account types and tax rules (07) | C1 (hooks from B1) |
| `CalendarSource` | Exchange and series holiday tables, as versioned data | A1 |
| `Notifier` | An alert channel (Discord, Telegram; later email, LINE): checks a target's shape and sends plain text | A2 |

## Self-describing
Each plug-in exports a description (`PluginInfo`): key (never changed once data exists), name, what it provides (kinds, tickers or series, currencies, markets), suggested role, the provider's limits (requests per minute/hour/day, symbols per month), whether it needs a key and which env variable, a link to the provider's terms, and flags:
- `noAi`: the provider's terms forbid giving its data to AI models. Its raw values are left out of the MCP server and AI exports.
- `unofficial`: not an official API (shown in Settings and the data-health page).

Each job run saves the descriptions to the database. The web app lists them in Settings, where the admin turns them on, orders them and assigns roles. Plug-ins suggest; the admin decides.

## Safety built into the SDK
- Plug-ins never call `fetch` directly. They use the HTTP client the core hands them, which keeps the provider's declared pace and caps (never above 80% of any limit), retries server errors with backoff, and stops that source for the run on 403, 429 or a captcha (never works around a block).
- Sources run one after another, each with its own client.
- Plug-ins return data; core validates it (layer A) before anything is stored. A plug-in cannot write to the database directly.
- Jobs and plug-ins refuse to run when `VERCEL` or `CI` is set.

## Where plug-ins live
| Folder | For |
|---|---|
| `plugins-public/` | Public plug-ins (official APIs: Tiingo, FRED, ECB, Alpaca/Massive; the Japan tax regime) and the templates |
| `plugins/` | The admin's own plug-ins, usually a private git repo mounted as a submodule (the owner's: `saku-private`). A missing folder is skipped: the public repo builds, tests and runs without it. |

## Templates
Runnable templates in `plugins-public/template/`: a `BarSource` for a made-up provider and a `TaxRegime` for a made-up country (one taxable account, one tax-advantaged account with an annual limit), each with fixtures and a passing test. A new plug-in starts by copying a template. `docs/plugins.md` documents every interface method and a checklist before turning a source on (terms checked, `noAi` set when needed, tests on fixtures pass, one real run looks right, role starts as secondary or check until its numbers agree).


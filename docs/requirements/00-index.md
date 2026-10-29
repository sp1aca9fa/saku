# Requirements index (start here)

## How to read
1. Read this index.
2. Read the file for the **current stage** in `stages/`. It lists the area files needed.
3. Read only the area files relevant to the task.
4. Read the full `REQUIREMENTS.md` only for the **completion check** at the end of a stage, or when the owner asks.

## Status
| Stage | Topic | Status |
|---|---|---|
| A1 | Data spike (gate) | in progress (server run) |
| A2 | Thin slice (forward records start) | in development (allowed during A1's observation window, see stage-a) |
| A3 | Hardened pipeline | in development (synthetic and stored data only, nothing live before the A1 gate) |
| B-F | See `stages/` | not started |

## Global constraints (apply to every task)
- Pillars in priority order: Reliability, Evidence, Decision clarity, Accessibility, Honesty and protection.
- **Nothing particular to one country, provider, broker, language or person is hardcoded in core.** It is a plug-in (15) or an admin setting (12). Core code, the database and docs are in US English; the app can run in any two languages, none of them English (08).
- Never present a normal signal on doubtful data: yellow warns, red switches to the strategy's declared safe state (04).
- Default execution is next-day; same-close execution is only for testfol parity tests (05).
- A closed, self-hosted app for a few accounts (a family); everyone brings their own data. Personal project; PolyForm Noncommercial 1.0.0; no paid service unless the owner approves.

## Area files
| File | Contents | Read when working on |
|---|---|---|
| 01-vision-targets.md | Vision, pillars, product model, targets, target reviews, gate, v1 | Target and stage reviews, trade-offs |
| 02-process.md | Rolling wave, stage reviews, backlog, decision log, external reviews | Reviews, planning, new ideas |
| 03-assets.md | Asset universe and tiers | Adding tickers or asset classes |
| 04-data-pipeline.md | Source roles, imports, schedule, calculations, verification, health status, safe state | Anything touching data |
| 05-strategy-model.md | Strategy model, execution, versions, registration, YAML, positions | Engine, builder, strategy storage |
| 06-indicators.md | Indicators and numeric rules | Indicators, signals |
| 07-accounts-tax.md | Tax engine, tax regime plug-ins, the Japan regime, comparisons | Tax, accounts, after-tax results |
| 08-ux-language.md | Languages, defaults, decision cards, metrics, guidance, acceptance | Any UI, content, alert text |
| 09-analytics.md | Robustness, statistics, Monte Carlo, library, finder | Robustness lab, library, finder |
| 10-mcp.md | MCP levels, export, context pack | MCP server, exports |
| 11-alerts.md | Alerts, channels, key-day alerts | Notifications |
| 12-architecture-stack.md | Stack, accounts and auth, admin settings, hosting, layout, non-functional, docs | Setup, infra, cross-cutting |
| 13-testing.md | Test strategy, fixtures, parity, golden values | Tests |
| 14-decisions-log.md | Decision history | When a decision changes |
| 15-plugins.md | Plug-in kinds, contract rules, public vs private, the template | Any data source, tax regime or other plug-in |

Other docs: `docs/system-design.md`, `docs/evidence/backtests.md`, `docs/backlog.md`, `docs/stage-reviews.md`, `docs/target-reviews.md`.


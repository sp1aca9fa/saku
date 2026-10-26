# Requirements index (start here)

## How to read
1. Read this index.
2. Read the file for the **current stage** in `stages/`. It lists the area files needed.
3. Read only the area files relevant to the task.
4. Read the full `REQUIREMENTS.md` only for the **completion check** at the end of a stage, or when the owner asks.

## Global constraints (apply to every task)
- Pillars in priority order: Reliability, Evidence, Decision clarity, Accessibility, Honesty and protection.
- The whole product is fully bilingual: English and Japanese (see 08).
- Never present a normal signal on doubtful data: yellow warns, red switches to the strategy's declared safe state (see 04).
- Default execution is next-day; same-close execution is only for testfol parity tests (see 05).
- Single owner per instance today, multi-user-ready data model; personal project; PolyForm Noncommercial 1.0.0; ¥0 budget unless the owner approves.

## Area files
| File | Contents | Read when working on |
|---|---|---|
| 01-vision-targets.md | Vision, pillars, product model, targets, target reviews, gate, v1 | Target and stage reviews, trade-offs |
| 02-process.md | Rolling wave, stage reviews, backlog, decision log, external reviews | Reviews, planning, new ideas |
| 03-assets.md | Asset tiers | Adding tickers or asset classes |
| 04-data-pipeline.md | Sources, imports, schedule, calculations, verification, health status, safe state | Anything touching data |
| 05-strategy-model.md | Strategy model, execution, versions, registration, YAML, positions | Engine, builder, strategy storage |
| 06-indicators.md | Indicators and numeric rules | Indicators, signals |
| 07-accounts-tax.md | NISA and taxable rules, tax engine, FX for tax, comparisons | Tax, accounts, yen results |
| 08-ux-language.md | Language, defaults, decision cards, metrics, guidance, acceptance | Any UI, content, alert text |
| 09-analytics.md | Robustness, statistics, Monte Carlo, library, finder | Robustness lab, library, finder |
| 10-mcp.md | MCP levels, export, context pack | MCP server, exports |
| 11-alerts.md | Alerts, channels, key-day alerts | Notifications |
| 12-architecture-stack.md | Stack, layout, compute placement, risks, non-functional, docs | Setup, infra, cross-cutting |
| 13-testing.md | Test strategy, parity, golden values | Tests |
| 14-decisions-log.md | Decision history | When a decision changes |

Other docs: `docs/system-design.md`, `docs/evidence/backtests.md`, `docs/backlog.md`, `docs/stage-reviews.md`, `docs/target-reviews.md`.


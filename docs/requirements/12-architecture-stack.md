# 12. Architecture, stack, non-functional

## Tech stack
| Area | Choice | Notes |
|---|---|---|
| Runtime | Node.js current Active LTS, pinned in `.nvmrc` | |
| Language | TypeScript `strict` | |
| Monorepo | pnpm workspaces + Turborepo | |
| Web | Next.js (App Router) with React | One deployable for UI and API routes; prefer client components unless server rendering clearly helps |
| UI | Tailwind CSS + shadcn/ui | |
| Charts | TradingView Lightweight Charts; ECharts or Recharts for heatmaps and distributions (chosen in D1) | |
| i18n | next-intl | |
| Client data | TanStack Query | |
| Validation / YAML | zod, `yaml` | |
| Database | Supabase Postgres (Tokyo), SQL migrations via Supabase CLI, generated types, supabase-js | |
| Auth | Supabase Auth: single owner account now, invites can be enabled later; RLS on all user-owned tables | |
| Jobs | Node CLI (tsx) in GitHub Actions | |
| Numerics | float64 analytics; decimal.js for money, tax, quotas | |
| Dates | date-fns + @date-fns/tz | |
| Logging | pino | |
| Market data | `yahoo-finance2`; Tiingo, FRED, ECB, issuers via fetch | |
| Integrity | SHA-256 hash chain; external timestamping (signed git tags or OpenTimestamps, decided in A2) | |
| MCP | `@modelcontextprotocol/sdk` | |
| Testing | Vitest, fast-check, Playwright | |
| Lint/format | ESLint, Prettier | |
| Hosting | Vercel Hobby, Supabase free, GitHub Actions, healthchecks.io, Discord webhook | ¥0 |

Dependencies must be compatible with PolyForm Noncommercial (MIT, Apache 2.0, BSD, ISC); no GPL/AGPL.

## Compute placement
Heavy computation (robustness sweeps, Monte Carlo, library evaluation) runs in GitHub Actions jobs or in the browser (Web Workers), never in Vercel serverless functions (time limits). Results are stored and displayed.

## Layout
```
apps/web, apps/jobs, apps/mcp
packages/core (engine, backtester, tax), packages/reference (independent core math),
packages/analytics, packages/data (adapters, verification, fault injection, calendar),
packages/db, packages/notify, packages/export, packages/content (EN/JA), packages/config
library/, templates/, fixtures/testfol/, scripts/docs-build
docs/ (requirements/, system-design.md, evidence/, data-pipeline.md, indicators.md, parity.md,
       robustness-score.md, strategy-library.md, backlog.md, stage-reviews.md, target-reviews.md,
       data-spike.md, user-guide/)
```
The owner's personal notes are kept outside the repository (the repo is public).

## Free-tier risks
| Risk | Mitigation |
|---|---|
| Cron delays or drops | Off-peak schedule; idempotent catch-up; daily retry run |
| Public-repo schedules disabled after 60 days without activity; forks have schedules disabled by default | Keep-alive; documented in quickstart; heartbeat |
| Supabase pauses after 1 week of inactivity | Daily job activity; verified over ≥ 10 calendar days in A1 |
| Yahoo throttling of cloud IPs | Secondary only; yellow, never red |
| Issuer website changes | Best-effort layer; yellow on failure |

## Non-functional
- Security: RLS; keys encrypted; secrets in GitHub/Vercel env; service-role key only in jobs; no keys or market data in the repo; MCP level 1 read-only.
- Observability: JobRun table, structured logs, admin page (runs, freshness, checks, storage, quotas, chain status).
- Performance: 30-year daily backtest < 2 s; nightly library evaluation < 5 min; one robustness sweep < 2 min (jobs or browser).
- Disclaimer: "not financial advice"; data accuracy not guaranteed, health status shown (EN/JA).

## Documentation and clone-and-run
- `README.md` quickstart (EN/JA): fork; create Tiingo and FRED keys; Supabase project; secrets; `bootstrap`; enable GitHub Actions in the fork; heartbeat; deploy; confirm data health is green.
- `docs/data-pipeline.md`, `docs/indicators.md`, `docs/user-guide/` (EN/JA), troubleshooting.


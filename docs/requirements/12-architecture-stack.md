# 12. Architecture, stack, accounts, hosting, non-functional

Built the same way as the owner's other app (Tora): a generic public repo, private specifics in a submodule, everything particular to a place or person as a plug-in or an admin setting.

## Tech stack
| Area | Choice | Notes |
|---|---|---|
| Runtime | Node.js current LTS, pinned in `.nvmrc` | pnpm via corepack (`packageManager`) |
| Language | TypeScript `strict` | |
| Monorepo | pnpm workspaces | |
| Web | Next.js (App Router) with React | UI and server actions; light work only |
| UI | Tailwind CSS + shadcn/ui | |
| Charts | TradingView Lightweight Charts; ECharts or Recharts for heatmaps and distributions (chosen in D1) | |
| i18n | next-intl, message files per language (08) | |
| Validation / YAML | zod, `yaml` | |
| Database | SQLite file through libSQL (`@libsql/client`) and Drizzle ORM | Add-only migrations (add first, drop in a later migration); migrations run from the server's CLI and the update script, never from a web request |
| Auth | Own `packages/auth` (password hashing, TOTP, backup codes, secret encryption) | See below |
| Jobs | Node CLI (tsx) run by systemd timers on the server | Refuse to run on Vercel or CI |
| Numerics | float64 analytics; decimal.js for money, tax, quotas | Money stored as decimal strings with currency |
| Dates | date-fns + @date-fns/tz | |
| Logging | pino | |
| Market data | Plug-ins (15) through the SDK's HTTP client | |
| Integrity | SHA-256 hash chain over RFC 8785 canonical JSON; RFC 3161 timestamps (`openssl ts`) | |
| MCP | `@modelcontextprotocol/sdk` | |
| Testing | Vitest, fast-check, Playwright | |
| Lint/format | ESLint, Prettier | |
| Hosting | The admin's always-on machine; Tailscale Funnel; healthchecks.io; Discord/Telegram | ¥0 |

Dependencies must be compatible with PolyForm Noncommercial (MIT, Apache 2.0, BSD, ISC); no GPL/AGPL/LGPL.

## Accounts and access
- A few accounts per install, one or more admins. **No sign-up page.** The first account (an admin) is made from the CLI: `pnpm user create <username>`. Afterwards admins manage accounts in Settings > Admin > Accounts (create, reset password or authenticator, revoke devices, disable), each task confirmed with the admin's own authenticator code; a new account or reset gives a one-time setup link (24 hours).
- Sign-in: username + password + authenticator code (TOTP), or one of 8 one-time backup codes. **At most 2 devices per account**; a third is refused until one is revoked. Sign-in checks the account's device slots first. Every refusal (unknown user, wrong password, disabled account, both slots taken) shows one message: "Username or password is wrong, or this account already has 2 devices signed in." Every path runs the password hash (a dummy one when the user is unknown or the slots are full), so response times give nothing away, and every refusal counts toward lockout. A third device never reaches the authenticator step. Lockout: 5 failures per IP per 15 min, 10 per username per hour, 50 overall per hour.
- Authorization is checked in every server action and route handler (never only in middleware), and every query on a user table is scoped by `owner_id`. Tests call each server action as the wrong user.
- **Demo account:** a normal account (same sign-in and device rules) filled with sample strategies, positions and journal entries by `pnpm demo <username>` (only accounts named `demo*` are touched), on the install's real market data. Used to show the app to someone.

## Admin settings (install-wide, no code edits)
Base currency (chosen before anything is stored), time zone (default display; trading dates stay America/New_York), primary and secondary language, asset universe, source roles and order (04), benchmark set (01), broker cost defaults, deposit rate, tax regime (07), default example amount, alert channels for admins. Each user has their own language, notification channels, tax accounts and defaults.

## Compute placement
Heavy computation (robustness sweeps, Monte Carlo, library evaluation) runs in server jobs (with lower CPU priority, see hosting) or in the browser (Web Workers), never in a web request. Results are stored and displayed.

## Layout
```
apps/web                 Next.js app (UI, server actions, auth pages)
packages/core            Engine: adjusted series, indicators, signals, strategies, execution, backtests, tax engine
packages/reference       Independent core math (never imports packages/core)
packages/analytics       Robustness, overfitting statistics, Monte Carlo, finder
packages/data            Verification layers, severity rules, fault injection, calendars
packages/plugin-sdk      Plug-in contracts, polite HTTP client, the jobs CLI (`pnpm daily`, `pnpm weekly`, ...)
packages/db              Drizzle schema, migrations, queries, user CLI, seed, backup and restore
packages/auth            Passwords, TOTP, backup codes, secret encryption
packages/content         Message files (en.json base, other languages)
packages/notify          Discord, Telegram
packages/export          AI export
packages/mcp             Read-only MCP server
plugins-public/          Publishable plug-ins (Tiingo, FRED, ECB, Alpaca/Massive, Japan tax regime) and the templates
plugins/                 Private plug-ins, ops, notes (git submodule `saku-private`; optional)
library/, templates/, fixtures/ (synthetic only), scripts/
docs/ (requirements/, system-design.md, evidence/, data-pipeline.md, indicators.md, parity.md,
       robustness-score.md, strategy-library.md, plugins.md, setup.md, running.md, backups.md,
       languages.md, backlog.md, stage-reviews.md, target-reviews.md, data-spike.md)
```
`plugins/` is not a pnpm workspace member (the public lockfile never depends on it); it imports `@saku/*` through the root `node_modules`, and typecheck and tests include it when present. Commit inside it first, then commit the pointer in the main repo.

## Hosting (self-hosted)
- One always-on machine (the owner's: a mini PC with Ubuntu Server, shared with Tora) runs everything as plain systemd services under the owner's user, no Docker:
  - `saku-app`: the web app on `127.0.0.1:3001` only.
  - `saku-daily.timer`: hourly check; runs the daily job once per trading day (04), then the backup and admin alerts. Weekly and monthly jobs through the same script, each with its own stamp and lock.
  - `saku-update.timer`: pulls new commits (both repos), installs, migrates, builds, restarts, checks the app answers; rolls back and alerts admins on failure; never while a job runs.
  - Heavy jobs run with `Nice=10` and a `CPUQuota`, so other apps on the machine stay responsive.
- Folders: `~/.local/share/saku/` (database, backups, analysis copy), `~/.local/state/saku/` (logs, stamps, locks); `SAKU_STATE_DIR` for a second copy on the same machine.
- Address: Tailscale Funnel on its own port (owner: `tailscale funnel --bg --https=8443 3001`). No router port opened.
- Backups: a daily compressed copy of the database (30 days plus the first of each month for 12 months), copied off the machine (the owner: to their PC over ssh). `pnpm restore` loads a copy into a new, empty database only. Each user can download their own data (JSON) and load it into an empty account.
- Outside watch: healthchecks.io gets a ping after each full daily success; it alerts when pings stop (the machine cannot report its own outage).
- Hosted options (e.g. Vercel + Turso) are not supported in v1; libSQL keeps them possible later.

## Risks of self-hosting
| Risk | Mitigation |
|---|---|
| The machine or network is down at run time | Hourly check catches up; a signal is for the next US session, so there are hours of slack; healthchecks.io alerts when pings stop |
| Disk failure | Daily backups off the machine; chain anchors kept with the backups |
| Clock drift (chain timestamps) | NTP on; clock offset shown on the admin page |
| Public address | Password + TOTP + lockout + 2 devices; authorization in every server action; Next.js kept patched (dependency updates reviewed monthly) |
| A provider changes or blocks | Secondary sources and roles (04); a blocked source stops for the run, never worked around |

## Non-functional
- Security: as above; secrets (provider keys, `AUTH_SECRET`) only in the server's `.env`; alert channel targets encrypted at rest; no keys or market data in the public repo; MCP read-only.
- Observability: job runs table, structured logs, admin pages (server status, runs, freshness, checks, database size and disk, quotas, chain status, activity log).
- Performance: 30-year daily backtest < 2 s; nightly library evaluation < 5 min; one robustness sweep < 2 min, measured on the owner's machine (Intel N150 class).
- Disclaimer: "not financial advice"; data accuracy not guaranteed, health status shown (in the install's languages).

## Documentation and clone-and-run
- `README.md`: what Saku is, quick start (local, with the demo seed), the guide table. Guides in `docs/`, one per topic: setup (machine, first user, first settings), plug-ins (contracts, template, testing), running (jobs, schedule, logs), backups, languages, data pipeline, indicators, troubleshooting.


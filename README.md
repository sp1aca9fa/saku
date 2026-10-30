# Saku

Saku is a self-hosted, rule-based investing assistant. You bring your own market data sources,
choose strategies that follow fixed rules on a few assets, and Saku checks the data, computes the
signals and records what it signaled in a tamper-evident forward record. It shows outcomes as
ranges in your base currency and says so when the data is in doubt. It is not financial advice and
does not promise returns. It runs on one always-on machine of your own and serves a few accounts
(a family); there is no sign-up page and no public site.

Source-available under PolyForm Noncommercial 1.0.0 (`LICENSE.md`). Requirements:
`docs/requirements/00-index.md`.

## Status

Stage A: the data pipeline and a command-line interface, server only. Saku fetches and checks
daily data, records forward results, sends alerts and runs on a schedule. There is no web app yet,
so everything below is done with `pnpm` commands on the server. The demo seed (sample strategies
and a demo account) comes with the web app.

## Quick start

Needs Node 24 (the version in `.nvmrc`) and pnpm (fetched by `corepack enable`).

```bash
git clone https://github.com/<you>/saku.git && cd saku
corepack enable
pnpm install
cp .env.example .env && chmod 600 .env   # see docs/setup.md for what to fill in
pnpm db:migrate
pnpm test                                # runs on synthetic fixtures, no network
pnpm check:all                           # typecheck, lint, format, tests, docs check
```

Tests never call a provider. Jobs (`pnpm bootstrap`, `pnpm daily`) fetch real data and need your
provider keys; they run only on the server and refuse to run when `CI` or `VERCEL` is set. The
full server setup is in `docs/setup.md`.

## Guides

| Guide | For |
|---|---|
| [docs/setup.md](docs/setup.md) | Setting up the server: Node, keys, first data, timers, alerts, updates |
| [docs/plugins.md](docs/plugins.md) | Writing a plug-in for your own data source |
| [docs/running.md](docs/running.md) | The jobs and commands, the schedule, locks, logs |
| [docs/backups.md](docs/backups.md) | What is backed up, copying it off the machine, restoring |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Common failures and what to do |
| [docs/languages.md](docs/languages.md) | Languages and adding one |
| [docs/data-pipeline.md](docs/data-pipeline.md) | How data is fetched, stored and checked |
| [docs/indicators.md](docs/indicators.md) | The indicators and how they are computed |
| [docs/parity.md](docs/parity.md) | Parity cases against external tools |
| [docs/system-design.md](docs/system-design.md) | The system design |

## Public and private code

`plugins-public/` holds plug-ins for official APIs and a runnable template. Your own plug-ins
(unofficial, scraped or personal sources) go in `plugins/`, usually a private git repo mounted as
a submodule. A missing `plugins/` folder is skipped.

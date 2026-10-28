# Setup (server)

Saku runs on one always-on Linux machine (Ubuntu Server 24.04 here) as systemd services under your
user, no Docker. Commands run on the server unless said otherwise; `<user>` is your user there and
the code is cloned to `~/code/saku`. The machine itself (updates, ssh keys, power-loss restart) is
set up as for any home server; nothing below is specific to one.

Stage A1 sets up the data jobs only: the web app (and its Tailscale Funnel address) comes later.

## 1. Node and the code

```bash
git clone https://github.com/<you>/saku.git ~/code/saku && cd ~/code/saku
# Optional: your private plug-ins (see "Private plug-ins" below).
git config submodule.plugins.url git@github-saku-private:<you>/saku-private.git
git submodule update --init

# Node with nvm, the version in .nvmrc (the machine's default Node is left alone).
nvm install && nvm use && corepack enable
# A stable path the services run Node through (move the link when .nvmrc changes).
mkdir -p ~/.local/share/saku
ln -sfn "$(dirname "$(dirname "$(nvm which "$(cat .nvmrc)")")")" ~/.local/share/saku/node
pnpm --version   # corepack fetches the pinned pnpm once
pnpm install
```

Private plug-ins: the server reads that repo with its own read-only deploy key.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/saku-private-deploy -N "" -C "server saku-private"
cat ~/.ssh/saku-private-deploy.pub   # GitHub: the private repo > Settings > Deploy keys, write access off
cat >> ~/.ssh/config <<'EOF'

Host github-saku-private
  HostName github.com
  User git
  IdentityFile ~/.ssh/saku-private-deploy
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
ssh -T github-saku-private          # "Hi <you>/saku-private! ..."
```

"Repository not found" means GitHub got another key: check the key is on the private repo, and
that no earlier block in `~/.ssh/config` (`Host *`) offers a different key first.

## 2. Settings and keys

```bash
cp .env.example .env && chmod 600 .env
```

Fill in `AUTH_SECRET` (`openssl rand -base64 48`, kept in a password manager) and the keys of the
sources you use (free accounts: Tiingo, Alpaca, Massive, FRED; ECB needs none). Then:

```bash
pnpm db:migrate
pnpm settings set base_currency <ISO code, e.g. EUR>   # once, before any data
pnpm settings set time_zone <IANA zone, e.g. Europe/Paris>
pnpm symbols import templates/universe/us-etf-tier0.json
pnpm user create <your username>                         # the first account is an admin
```

## 3. First data

```bash
pnpm bootstrap   # full history from every source, then layers A-C over it
pnpm spike       # (after daily runs) the A1 gate, day by day
```

The bootstrap takes a few minutes (the slowest source sets the pace: 5 calls per minute on
Massive's free plan). Source roles are set from the plug-ins' suggestions the first time (one
primary per data kind, logged in the activity log).

## 4. The hourly check

`ops/systemd/saku-daily.service` and `.timer` run every hour at :20: the finalization probe, then
the daily job, which does its work once per trading day (the first check after 20:00 New York
time, after the day's data is final) and exits at once otherwise. Copy them, replace `<user>`:

```bash
sudo cp ops/systemd/saku-daily.* /etc/systemd/system/
sudo sed -i "s/<user>/$USER/g" /etc/systemd/system/saku-daily.service
sudo systemctl daemon-reload && sudo systemctl enable --now saku-daily.timer
```

The service runs at lower priority (`Nice=10`) with a CPU cap, so other apps on the machine stay
responsive. Logs: `journalctl -u saku-daily` and JSON lines in `~/.local/state/saku/logs/`; the
probe's measurements in `~/.local/state/saku/probe.jsonl`.

## 5. Outside watch

Create a check on healthchecks.io (free): period 1 day, grace 6 hours, and put its URL in `.env`
as `HEALTHCHECK_URL`. Each fully successful daily run pings it; when pings stop (the machine is
down, a source keeps failing, a backup failed), healthchecks.io tells you. The machine cannot report
its own outage.

Alerts (strategy changes, data health, failed runs for admins) go to Discord or Telegram:

```sh
# Discord: Server Settings > Integrations > Webhooks > New Webhook, copy its URL.
# Telegram: create a bot with @BotFather, put TELEGRAM_BOT_TOKEN in .env, send the bot a message,
# then read your chat id from https://api.telegram.org/bot<token>/getUpdates.
pnpm channel add discord --user <name> --admin   # asks for the target; --admin: also failed runs
pnpm channel list --user <name>
pnpm channel test <channel id> --user <name>
```

An alert that could not be delivered leaves the run incomplete; it is retried at the next hourly
check, so a broken channel also stops the healthchecks.io ping. `pnpm channel disable` turns one off.
Users' languages: `pnpm settings set primary_language ja` (the default for users who chose none).

## 6. Backups

Each daily run writes `~/.local/share/saku/backups/saku-<date>.db.gz` (checked with SQLite's
integrity check before it is kept) and keeps 30 days plus the first of each month for 12 months.
`pnpm backup` makes one now. Copy them off the machine; from another computer, for example:

```bash
rsync -a --delete <server>:.local/share/saku/backups/ ~/saku-backups/
```

`pnpm restore <file> [target.db]` unpacks a backup into a new database file only (never over an
existing one); then `pnpm db:migrate`. A restored database needs the same `AUTH_SECRET`.

## 7. Updates

The server updates itself: every 5 minutes it checks GitHub, and when there are new commits it
pulls both repos, installs the Node version in `.nvmrc` when it changed (nvm's default is left
alone), installs packages, migrates, and checks the new version (the plug-ins load, typecheck,
tests). Never while a job runs (it waits for the next check), and no job starts during it. When a
step fails, it goes back to the version before and does not try that version again until a newer
push. Every update is in the activity log; the log is `~/.local/state/saku/update.log`.

```bash
sudo cp ops/systemd/saku-update.* /etc/systemd/system/
sudo sed -i "s/<user>/$USER/g" /etc/systemd/system/saku-update.service
sudo systemctl daemon-reload && sudo systemctl enable --now saku-update.timer
```

By hand, any time: `ssh -t <server> code/saku/ops/update-server.sh`.

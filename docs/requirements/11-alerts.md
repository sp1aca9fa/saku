# 11. Alerts and notifications

## Channels
Discord and Telegram, configured per user in Settings (stored encrypted). Admins also get operational alerts (failed jobs, data health, server updates, the address down). Email and LINE in the backlog. Alerts in each user's selected language.

## Alert types
| Alert | When | Stage |
|---|---|---|
| Strategy state change | Active allocation changes; states the execution timing (e.g. "trade at the next US open") | A2 |
| Data health | Yellow (warning) or red (safe-state action with exact instructions) | A2 |
| Job failure | Admins | A2 |
| Position mismatch | Holdings differ from target; includes rebalance calculator orders (whole shares) | D1 |
| Strategy health | Live drawdown exceeds the worst 5% predicted by the backtest | D2 |
| Key-day alert | Before an important US session | F1 |
| Finder | Optional (see 09) | F3 |

Every alert states the data-health status. Idempotent per (strategy version, trading date, alert type).

## Key-day alerts (F1, right after v1)
- Sent a few hours before the US open (around 21:00 JST on the owner's install) when a scheduled event (FOMC, CPI, jobs report), signal proximity (close near a threshold) or stress state (volatility spike, large prior-day drop) makes the session important.
- Contents: why it matters, precomputed price levels, suggested pre-session stop orders (order types and validity are a broker setting; the owner's broker verified in F1).
- Backtested with daily OHLC (fill at the stop, or at the open on gaps, plus slippage). Capped frequency, ranked by severity. On by default only if it improves after-tax risk-adjusted results.


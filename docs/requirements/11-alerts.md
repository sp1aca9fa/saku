# 11. Alerts and notifications

## Channels
Discord webhook first, configured per user in the database (a channel per user); the owner's job-failure alerts may use an env webhook. Email, Telegram, LINE in the backlog. Alerts in the user's selected language.

## Alert types
| Alert | When | Stage |
|---|---|---|
| Strategy state change | Active allocation changes; states the execution timing (e.g. "trade at the next US open") | A2 |
| Data health | Yellow (warning) or red (safe-state action with exact instructions) | A2 |
| Job failure | Owner | A2 |
| Position mismatch | Holdings differ from target; includes rebalance calculator orders (whole shares) | D1 |
| Strategy health | Live drawdown exceeds the worst 5% predicted by the backtest | D2 |
| Key-day alert | Before an important US session | F1 |
| Finder | Optional (see 09) | F3 |

Every alert states the data-health status. Idempotent per (strategy version, trading date, alert type).

## Key-day alerts (F1, right after v1)
- Sent around 21:00 JST when a scheduled event (FOMC, CPI, jobs report), signal proximity (close near a threshold) or stress state (volatility spike, large prior-day drop) makes the session important.
- Contents: why it matters, precomputed price levels, suggested pre-session stop orders (SBI US order types and validity verified in F1).
- Backtested with daily OHLC (fill at the stop, or at the open on gaps, plus slippage). Capped frequency, ranked by severity. On by default only if it improves after-tax risk-adjusted results.


# 10. MCP server and AI export

The app makes no LLM calls. Claude is used on request through MCP within the owner's Claude plan.

## Level 1: read-only (E1, in v1)
- Tools: strategies and versions; YAML; current state with data-health status; backtests on demand (in memory, nothing persisted); forward results with chain verification status; positions, trades and journal; decision cards; tax comparisons; data-health and audit reports.
- No database writes, no notifications. Reads the **analysis copy** (the latest daily backup, unpacked on the machine running Claude), opened read-only, for one user (`--user <username>`): that user's data plus shared data. Never deployed.
- Sources whose terms forbid giving their data to AI models (`noAi`, 15) are left out: their raw values never appear in responses, only results computed from them, and only if their terms allow that.

## AI export
UI button, CLI and MCP tool producing a compact bundle: Markdown summary + JSON (YAML, key stats, downsampled equity, switches, forward vs backtest). Default under 20,000 characters.

## Context pack (on request only)
Exposures (effective leverage, asset mix, account mix, base-currency and USD cash exposure, rate sensitivity), signal state and regime history (from B3), for Claude to combine with current news and produce scenarios (base/bear/bull, what the strategy would do in each) for 6-month, 1, 3 and 5-year horizons.

## Level 2 (F6) and level 3 (F7)
- Level 2: natural-language strategy building (YAML validated by the same schema; creates drafts only), save backtests, add finder candidates.
- Level 3: trades, journal entries, notification settings; destructive actions require explicit confirmation.

## General
Local stdio server (`pnpm mcp --user <username>`) for Claude Code and Claude Desktop. Compact responses; long series downsampled; signal responses include data-health status.


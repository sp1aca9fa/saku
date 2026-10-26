# Pre-build issues: what is still open (2026-10-26, round 3)

Working notes. Every decided item is now in the split requirement files, `docs/system-design.md` (v0.4) and `CLAUDE.md`, with entries in `14-decisions-log.md`. Delete this file once item 6 is decided.

## Open

### 6. Revision log flooded by provider re-adjustments (owner to decide)
Tiingo rewrites `adjClose` for the whole history after every dividend; Yahoo rewrites split-adjusted closes after every split. With "never silently overwrite", each SPY dividend would log ~8,000 revisions (TLT/IEF pay monthly), burying real revisions. The same happens to our own `adj_close` if it is back-adjusted.

Proposal:
- The revision log tracks raw fields only: open, high, low, unadjusted close, volume, dividend, split.
- Provider-adjusted values keep the latest snapshot plus one "provider re-adjustment" event per refetch (date range, implied factor). They are only used for return comparisons, which do not change when the whole series is rescaled.
- Our adjusted series is a **forward-accumulated total-return index** (1.0 on the first date; history never changes). Signals such as price > SMA on the total-return series do not change when the whole series is rescaled, so testfol semantics are unaffected, and incremental vs full recomputation becomes exact.

Must be decided before the Stage A migrations are final (A1).

## To verify in A1 (already in stage-a)
- Alpaca: free consolidated daily bars since 2016, 200 calls/min; corporate actions coverage; whether a paper-only account is open to residents of Japan.
- Massive (formerly Polygon): free end-of-day, 2 years, 5 calls/min, "individual use"; whether the grouped daily endpoint is on the free plan.
- Each provider's terms on giving data to AI models (`noAi`). Tiingo runs its own MCP server for AI agents, which suggests it allows it, but its terms decide.

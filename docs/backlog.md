# Backlog

| Date | Idea | Raised by | Pillar | Status (new / accepted / rejected / experiment) | Notes |
|---|---|---|---|---|---|
| 2026-10-29 | Page crawler with screenshots (phone, wide, dark, each language) and checks for console errors, raw text keys, sideways scroll and faint text, for the UX review (`docs/ux-review.md`) | owner (from Tora) | Accessibility | accepted | Built with the first pages (D1); needs `playwright-core` (Apache 2.0), approved then |
| 2026-10-29 | With several users, a broken channel of one user should not hold back the run's heartbeat for everyone (today any undelivered alert leaves the run incomplete) | Claude | Reliability | new | Fine while single user; e.g. retry user channels for a day, then an admin alert |
| 2026-10-29 | Faster daily forward step: load bars once per run, prefix-sum SMA (as the reference does), incremental equity instead of a replay from the record's start | Claude (review) | Reliability | accepted (partly) | Bars and the record are now read once per run (2026-10-30); indicators and the equity replay still recompute per date, needed before the strategy library (B) |
| 2026-10-30 | A separate healthchecks.io check for the weekly run | Claude | Reliability | new | Today only the daily run pings |
| 2026-10-30 | FRED values withdrawn (revised to '.') or leaving the 10-year licence window keep the old vintage as latest, silently; store or flag withdrawn values | Claude (review) | Reliability | new | Pre-existing; affects asOf for a withdrawn value |
| 2026-10-30 | ECB: accept a leading empty part only when the series really starts later (ask for its first observation) | Claude (review) | Reliability | new | A wrong 404 on the first part would shorten history silently |
| 2026-10-30 | Issuer sources declare what they publish (NAV, distributions, splits), so a NAV-only file does not flag every ex-date | Claude | Reliability | new | Layer D is advisory until thresholds are set |
| 2026-10-30 | Index on `data_health(run_id)` | Claude | Reliability | new | The health report scans it per run; small tables for now |
| 2026-10-30 | Full passes store per-symbol green coverage, so a symbol skipped in a full run never reads green from older data | Claude (review) | Reliability | new | Coverage ranges cover the known cases |
| 2026-10-30 | Compare holdings order-insensitively when counting switches (a reorder with no trade counts today) | Claude (review) | Evidence | new | Core change; matters for testfol parity |
| 2026-10-30 | testfol parity: check the cash rate series' health in the case window | Claude (review) | Reliability | new | Leveraged and cash cases depend on it |
| 2026-10-30 | Plug-ins declare a calendar per series or pair (TARGET for ECB, Fed for DTB3), so expected gaps are exact | Claude | Reliability | new | NYSE calendar used meanwhile |

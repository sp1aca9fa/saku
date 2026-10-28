# Backlog

| Date | Idea | Raised by | Pillar | Status (new / accepted / rejected / experiment) | Notes |
|---|---|---|---|---|---|
| 2026-10-29 | Page crawler with screenshots (phone, wide, dark, each language) and checks for console errors, raw text keys, sideways scroll and faint text, for the UX review (`docs/ux-review.md`) | owner (from Tora) | Accessibility | accepted | Built with the first pages (D1); needs `playwright-core` (Apache 2.0), approved then |
| 2026-10-29 | Admin alert when a self-update fails (today: update log and activity log only) | Claude | Reliability | new | Small: the update script calls an alert command after rolling back |
| 2026-10-29 | With several users, a broken channel of one user should not hold back the run's heartbeat for everyone (today any undelivered alert leaves the run incomplete) | Claude | Reliability | new | Fine while single user; e.g. retry user channels for a day, then an admin alert |
| 2026-10-29 | Admin data-health alert for the whole universe (today data-health alerts are per registered strategy) | Claude | Reliability | new | Requirements 11 lists data health among admin alerts |

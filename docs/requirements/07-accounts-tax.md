# 07. Accounts and tax

## Roles of accounts
- **特定口座 (default):** where timing and leveraged strategies live.
- **NISA (opt-in per instance):** for the steady core and DCA plans. Timing strategies generally do not fit NISA: quota frees up only the following year, and つみたて投資枠 allows periodic purchases only.
- Holdings cannot be moved from 特定口座 into NISA; a "fallback to NISA" means selling (possibly taxable) and rebuying (using quota). The tool shows both costs.

## Enforced rules
| Rule | NISA 成長投資枠 | NISA つみたて投資枠 | 特定口座 |
|---|---|---|---|
| Leveraged products | Not eligible | Not eligible | Allowed |
| Eligible products | Listed stocks/ETFs and eligible funds | FSA-designated funds only (labeled ETF proxies until Japanese fund data exists) | All |
| Purchases | Lump sum or periodic | Periodic (DCA) only | Any |
| Annual quota | ¥2.4M | ¥1.2M | n/a |
| Lifetime limit | ¥18M shared (成長 max ¥12M); sold amounts free up quota the next year at book value | Same shared limit | n/a |
| Tax on gains | None | None | 20.315% on realized gains |
| Losses | No offset | No offset | Offset gains and dividends; 3-year carryforward via 確定申告 |
| US ETF dividends | 10% US withholding, no foreign tax credit | Same | Withholding + Japanese tax; foreign tax credit possible |

- A quota tracker shows annual and lifetime usage; the tool warns before and blocks any plan that would exceed limits.
- The owner (tax background) verifies all rules before C1 implementation.

## Tax engine
Tax lots; realized gains per switch using broker-style FX rates (TTM/TTS/TTB as applicable); loss offsets and carryforward; dividend withholding; NISA quota ledger. Hooks in the backtester from B1; completed in C1. Verified with owner-computed golden cases (no second implementation for tax).

## Tax-free vs taxable comparison
- Same period, in yen, after tax; taxable strategies on **liquidation value**.
- Rolling 5-year windows showing which approach won and by how much.
- Hybrid view: NISA core plus taxable satellite.

## Japan tax optimization (F4, candidate to pull earlier)
Asset location (what belongs in NISA vs 特定口座 given quota); year-end loss harvesting in 特定口座 (respecting cost-basis averaging rules for same-day repurchases); choosing December vs January for realizing gains.


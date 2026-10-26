# 07. Accounts and tax

## Model
- **Tax is a plug-in.** Core holds a generic tax engine; a **tax regime plug-in** (15) supplies a country's rules. The admin picks the install's regime in Settings. The public repo ships the Japan regime (below) and a template regime for a made-up country.
- **Accounts are per person.** Each user has their own tax accounts, quota ledger, tax lots and loss carryforward (tax-advantaged accounts such as NISA are per individual by law). The install's regime defines which account types exist.
- Every regime defines a `taxable` account type (the default for timing and leveraged strategies) and any number of tax-advantaged account types.

## What a regime plug-in declares
| Area | Examples |
|---|---|
| Account types | Key, names (per language), taxable or tax-advantaged |
| Eligibility | Which products an account may hold (e.g. no leveraged ETFs), purchase modes (lump sum, periodic only) |
| Quotas | Annual and lifetime limits, how sold amounts free up quota and when |
| Tax on gains and income | Rates on realized gains and on dividends per account type |
| Losses | Offsets (against gains, dividends), carryforward length, conditions (e.g. a filing requirement) |
| Foreign dividends | Withholding at source, foreign tax credit availability per account type |
| Cost basis | Lot method (e.g. moving average), same-day repurchase rules |
| FX for tax | Which rate applies to purchases, sales and dividends (e.g. TTM, TTS, TTB) |
| Transfers | Whether holdings can move between account types (if not, a "move" is sell + rebuy, with both costs shown) |
| Texts | Every user-facing name and explanation, in the plug-in's language files |

The engine computes; the regime only declares. Rules that cannot be declared with the contract are a reason to extend the contract (at a stage review), never to put country code in core.

## Japan regime (public plug-in, the owner's install)
- **特定口座 (`taxable`):** where timing and leveraged strategies live.
- **NISA (opt-in per user):** for the steady core and DCA plans. Timing strategies generally do not fit NISA: quota frees up only the following year, and つみたて投資枠 allows periodic purchases only.
- Holdings cannot be moved from 特定口座 into NISA; a "fallback to NISA" means selling (possibly taxable) and rebuying (using quota). The tool shows both costs.

| Rule | NISA 成長投資枠 | NISA つみたて投資枠 | 特定口座 |
|---|---|---|---|
| Leveraged products | Not eligible | Not eligible | Allowed |
| Eligible products | Listed stocks/ETFs and eligible funds | FSA-designated funds only (labeled ETF proxies until local fund data exists) | All |
| Purchases | Lump sum or periodic | Periodic (DCA) only | Any |
| Annual quota | ¥2.4M | ¥1.2M | n/a |
| Lifetime limit | ¥18M shared (成長 max ¥12M); sold amounts free up quota the next year at book value | Same shared limit | n/a |
| Tax on gains | None | None | 20.315% on realized gains |
| Losses | No offset | No offset | Offset gains and dividends; 3-year carryforward via 確定申告 |
| US ETF dividends | 10% US withholding, no foreign tax credit | Same | Withholding + Japanese tax; foreign tax credit possible |

- A quota tracker shows each user's annual and lifetime usage; the tool warns before and blocks any plan that would exceed limits.
- The owner (tax background) verifies all Japan rules, including the FX convention for foreign-currency trades, before C1 implementation.

## Tax engine
Tax lots; realized gains per switch using the regime's FX convention; loss offsets and carryforward; dividend withholding; quota ledger. Hooks in the backtester from B1; completed in C1. Verified with owner-computed golden cases (no second implementation for tax). The template regime has its own golden cases.

## Tax-free vs taxable comparison
- Same period, in the base currency, after tax; taxable strategies on **liquidation value**.
- Rolling 5-year windows showing which approach won and by how much.
- Hybrid view: tax-advantaged core plus taxable satellite.

## Tax optimization (F4, candidate to pull earlier)
Declared by the regime where it applies. For Japan: asset location (what belongs in NISA vs 特定口座 given quota); year-end loss harvesting in 特定口座 (respecting cost-basis averaging rules for same-day repurchases); choosing December vs January for realizing gains.


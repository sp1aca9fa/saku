# 08. UX, language, decision clarity

## Languages (mandatory)
- Code, comments, commits, database values and technical docs are in US English. Every user-facing text goes through `packages/content` (next-intl message files); no hardcoded user-facing text anywhere, including plug-ins (each plug-in ships its own message files).
- **The install runs in any two languages, neither of which has to be English** (e.g. Portuguese + Spanish). The admin picks a primary language (sign-in page, default) and an optional secondary one (the toggle) in Settings, from the installed language files. Each user switches between the two; the choice is stored in their settings.
- `en.json` is the base file and holds every text. Other language files may be partial; a missing text falls back to English. Languages are found from the files at build time, so anyone can add one.
- `pnpm languages` lists what each language lacks. From D1, CI fails when a language the owner's install uses (EN, JA) lacks a text; other installs run the same check for their own languages.
- Covered: every screen, tooltip, help panel, guided tour, glossary entry, decision card, chart label, error, empty state, alert, export header and user guide. The README and docs in `docs/` are English.
- Locale-aware dates, numbers, currency and percentages, following the page's language and the base currency.
- Natural financial terminology per language (e.g. 最大ドローダウン in Japanese); regime-specific terms (e.g. 特定口座) live in the tax regime plug-in's files. The owner reviews Japanese.
- Alerts in each user's selected language.

## Defaults instead of questionnaires
- One opinionated default: aggressive tier, leverage only in favorable conditions, parameter ensembles instead of single parameters, frequent fallbacks, the regime's taxable account, next-day execution.
- All assumptions (tier, drawdown limit, example amount, costs, FX spread, cash currency, account type, execution, safe state) visible and editable. Default example amount: an admin setting in the base currency (the owner's install: ¥100,000), with whole-share effects shown.
- Risks (leverage, drawdown, tax, gap risk, short asset histories) shown clearly before a risky setting takes effect. No profiling quiz.

## Decision card (every strategy, fallback comparison and finder candidate)
- Return range (10th-90th percentile over 5 years) and median, not a single number.
- Bad-case and historical worst-case loss **in the base currency** for the user's amount; time to recover.
- Costs, FX and tax drag; eligibility for the regime's tax-advantaged accounts.
- What happens if the user deviates (quits at the bottom, delays re-entry).
- Comparison against the install's benchmark set (01).
- History length and crisis coverage; wide confidence ranges flagged.
- Plain-language verdict of the trade-off.

## Information-parity metric set (every strategy)
CAGR, cumulative return, volatility, downside deviation, Sharpe, Sortino, Calmar, max drawdown, average drawdown, longest drawdown and recovery time, Ulcer index, beta and correlation vs S&P 500 and All Country, VaR 95%, CVaR 95%, best and worst year, % positive months, rolling 5-year return range (median and share meeting target), switches per year, average exposure/leverage, cost drag, tax drag, deflated Sharpe ratio, probability of backtest overfitting.

## Guidance
- Tooltips on every metric, indicator, setting, column and chart element (definition, why it matters, example), in the install's languages, coverage enforced in CI.
- "How to use this page" panel on every page; onboarding checklist; replayable guided tours; glossary; plain-language summaries above numbers; empty states and errors that say what to do next.
- Starter templates (buy and hold SPY, ensemble trend filter, owner's Setup 1 with ensemble, dual momentum), each with a decision card.
- User guide in the app, from message files (so it follows the install's languages). Mobile-friendly, dark mode.
- A UI feature is done only when its guidance content exists in `en.json` and in the owner's install languages (EN, JA).

## Acceptance (before v1)
3-5 test users unfamiliar with the tool, on the owner's install (demo account or their own), complete onboarding to a first alert with in-app guidance only (in their chosen language); at least 4 of 5 correctly state a strategy's bad-case loss in the base currency.


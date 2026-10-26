# 08. UX, language, decision clarity

## Language (mandatory)
- The entire product is **fully available in English and Japanese**: every screen, tooltip, help panel, guided tour, glossary entry, decision card, chart label, error, empty state, alert, export header, user guide and README quickstart.
- No feature ships in one language only. The content package (`packages/content`) is used from day one; the CI translation gate is enforced from D1.
- Language switch on every page, stored in settings. Default: browser language, fallback English.
- Locale-aware dates, numbers, currency (¥, $) and percentages.
- Natural Japanese financial terminology (e.g. 最大ドローダウン, 特定口座), reviewed by the owner.
- Alerts in the selected language. Code, comments, commits and technical docs in English.

## Defaults instead of questionnaires
- One opinionated default: aggressive tier, leverage only in favorable conditions, parameter ensembles instead of single parameters, frequent fallbacks, 特定口座, next-day execution.
- All assumptions (tier, drawdown limit, example amount, costs, FX spread, cash currency, account type, execution, safe state) visible and editable. Default example amount: ¥100,000 (with whole-share effects shown).
- Risks (leverage, drawdown, tax, gap risk, short asset histories) shown clearly before a risky setting takes effect. No profiling quiz.

## Decision card (every strategy, fallback comparison and finder candidate)
- Return range (10th-90th percentile over 5 years) and median, not a single number.
- Bad-case and historical worst-case loss **in yen** for the user's amount; time to recover.
- Costs, FX and tax drag; NISA eligibility.
- What happens if the user deviates (quits at the bottom, delays re-entry).
- Comparison against the benchmark set (01), including S&P 500 in NISA.
- History length and crisis coverage; wide confidence ranges flagged.
- Plain-language verdict of the trade-off.

## Information-parity metric set (every strategy)
CAGR, cumulative return, volatility, downside deviation, Sharpe, Sortino, Calmar, max drawdown, average drawdown, longest drawdown and recovery time, Ulcer index, beta and correlation vs S&P 500 and All Country, VaR 95%, CVaR 95%, best and worst year, % positive months, rolling 5-year return range (median and share meeting target), switches per year, average exposure/leverage, cost drag, tax drag, deflated Sharpe ratio, probability of backtest overfitting.

## Guidance
- Tooltips on every metric, indicator, setting, column and chart element (definition, why it matters, example), EN/JA, coverage enforced in CI.
- "How to use this page" panel on every page; onboarding checklist; replayable guided tours; glossary; plain-language summaries above numbers; empty states and errors that say what to do next.
- Starter templates (buy and hold SPY, ensemble trend filter, owner's Setup 1 with ensemble, dual momentum), each with a decision card.
- User guide in `docs/user-guide/` (EN/JA), rendered in the app. Mobile-friendly, dark mode.
- A UI feature is done only when its guidance content exists in EN and JA.

## Acceptance (before v1)
3-5 test users unfamiliar with the tool, on a deployed instance, complete onboarding to a first alert with in-app guidance only (in their chosen language); at least 4 of 5 correctly state a strategy's bad-case loss in yen.


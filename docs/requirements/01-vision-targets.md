# 01. Vision, pillars, product model, targets

## Vision
**The best personal investment assistant for rule-based investors: deep strategies on a few assets, verified with honest analytics, powered by data you bring yourself, and operated through Claude via MCP.**

Longer term: make evidence-backed, professional-grade strategies usable by anyone, including people with little investment knowledge, with honest decisions and visible uncertainty.

## Pillars (priority order)
1. **Reliability.** We never act on wrong data or wrong calculations. Data and math are checked redundantly and independently. When data is in doubt, the tool never presents a normal signal: yellow status computes with a visible warning; red status switches to the strategy's declared safe state and tells the user exactly what to do.
2. **Evidence.** Strategies are grounded in published research, verified with robustness and overfitting statistics, and judged on forward (post-registration) results, which are tamper-evident.
3. **Decision clarity.** Every choice is shown as trade-offs in the base currency and in ranges (return, bad-case loss, recovery time, costs, tax), so the user decides knowingly. The tool educates on decisions, not finance theory.
4. **Accessibility.** Professional methods usable without understanding the math, executable at a real broker with real costs, real execution timing and real tax.
5. **Honesty and protection** (cross-cutting). Show uncertainty and luck, never oversell, make risks impossible to miss.

## Product model
- **Closed, personal app.** Each install serves a few accounts (a family) with one or more admins. No sign-up page, no public pages, no public demo. Each person sees only their own strategies, positions, journal and tax data; market data, checks, data health and the strategy library are shared within the install.
- **Bring your own data.** The public repo ships the app, the plug-in framework, public plug-ins for official APIs and a runnable template. Each admin chooses and writes plug-ins for their own sources and is responsible for their terms (15).
- **Works anywhere.** Base currency, time zone, languages, asset universe, benchmarks, broker costs and tax regime are admin choices or plug-ins, never code edits. The owner's install uses JPY, Asia/Tokyo, English and Japanese, and the Japan tax regime.
- **Self-hosted** on an always-on machine of the admin's own, reached through a tunnel (12). A demo account (same security as any account, sample strategies, no personal data) is used to show the app to someone.
- **Template-worthy, source-available.** Anyone can clone and run their own install under PolyForm Noncommercial 1.0.0. Commercial use is not a goal.

## Audience
The owner and their family first; designed so an individual with little investment knowledge can use it, in their own languages.

## Benchmark set
Judged in the base currency, after tax and costs, against what an individual would realistically hold. Index benchmarks are assumed held in the regime's best tax-advantaged account (e.g. NISA in Japan), because that is the realistic alternative. The set is an admin setting; the owner's install uses:
- S&P 500 index fund in NISA (modeled with SPY in yen minus fee)
- Global index fund in NISA (eMAXIS Slim All Country; modeled with VT in yen minus fee)
- Balanced 8-asset fund in NISA (ETF composite, defined in C2)
- Robo-advisor style portfolio (ETF mix, defined in C2)
- Gold (GLD in yen)
- Bank deposits (actual current deposit rate)

## Outcome targets
Targets apply to a **strategy slice**, not the whole portfolio (the user may hold e.g. 50% in a safe core and 10% in an aggressive strategy). Measured on the **median rolling 5-year window**, with the share of windows meeting the target and a confidence range always reported. Backtests use next-day execution, realistic costs and tax. The targets below are the owner's, measured on the owner's install (JPY, Japan regime).

| Tier | Target |
|---|---|
| Aggressive (default) | Beat S&P 500 buy and hold held in NISA by 5-10pp per year in yen after tax and costs, with max drawdown no worse than S&P 500's and higher Sharpe and Calmar ratios |
| Balanced | Match All Country (NISA) return with at most 60% of its max drawdown |
| Conservative | Beat the balanced 8-asset fund (NISA) with no worse max drawdown |

Initial evidence for the aggressive target: `docs/evidence/backtests.md` (pre-tax, same-close execution; re-run with next-day execution and tax at TR1). Whole-portfolio targets are defined at F5.

## Pillar targets
| Pillar | Target | Measurement |
|---|---|---|
| Reliability | 100% of injected material faults detected (faults larger than the relevant tolerance, all sources available); zero normal signals presented on red data | Fault-injection suite (CI); audit log |
| Reliability (process) | Data status green on ≥ 99% of trading days (yellow and red tracked separately) | Data-health history |
| Evidence | 100% of library strategies cite research and show tamper-evident post-registration results | Library review; chain verification |
| Decision clarity | ≥ 4 of 5 test users correctly state a strategy's bad-case loss in the base currency after reading its page | Usability test (3-5 people) |
| Decision clarity | 100% coverage of the information-parity metric set for every strategy | Automated check |
| Accessibility | 100% tooltip coverage; on a running install, a novice reaches a first strategy in < 15 minutes | CI check; usability test |
| Accessibility (language) | 100% of user-facing strings exist in the install's chosen languages | `pnpm languages` check (enforced from D1) |
| Execution (process) | ≥ 95% of signals acted on within one trading day; live results inside the backtest's expected range | Discipline journal; forward tracking |

## Target reviews
| Review | When | Evidence |
|---|---|---|
| TR1 | After Stage B1 | Re-run evidence with next-day execution, costs and tax in yen; median and share of 5-year windows |
| TR2 | At v1 | Process targets, parity, first forward data, usability test |
| TR3 | After the strategy finder | Robustness and overfitting statistics, Monte Carlo probabilities |
| TR4 | After the whole-portfolio view | 12+ months of forward data in real yen |

Each review records evidence, decision (keep, raise, lower) and rationale in `docs/target-reviews.md`. Targets are never pursued by overfitting or by loosening integrity rules.

## Gate
If Stage A1 (data spike) fails its gate, stop and report to the owner.

## v1 definition
v1 = Stages A, B, C, D and E1, plus usability acceptance (08) and TR2.


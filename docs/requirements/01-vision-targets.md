# 01. Vision, pillars, product model, targets

## Vision
**The best personal investment assistant for rule-based investors: deep strategies on a few assets, verified with honest analytics, powered by free or near-free data, and operated through Claude via MCP.**

Longer term: make evidence-backed, professional-grade strategies usable by anyone, including people with little investment knowledge, with honest decisions and visible uncertainty.

## Pillars (priority order)
1. **Reliability.** We never act on wrong data or wrong calculations. Data and math are checked redundantly and independently. When data is in doubt, the tool never presents a normal signal: yellow status computes with a visible warning; red status switches to the strategy's declared safe state and tells the user exactly what to do.
2. **Evidence.** Strategies are grounded in published research, verified with robustness and overfitting statistics, and judged on forward (post-registration) results, which are tamper-evident.
3. **Decision clarity.** Every choice is shown as trade-offs in yen and ranges (return, bad-case loss, recovery time, costs, tax), so the user decides knowingly. The tool educates on decisions, not finance theory.
4. **Accessibility.** Professional methods usable without understanding the math, executable at a real Japanese broker with real costs, real execution timing and real tax.
5. **Honesty and protection** (cross-cutting). Show uncertainty and luck, never oversell, make risks impossible to miss.

## Product model
- **Personal project.** The owner is the user. Each instance has a single owner today.
- **Multi-user-ready data model:** every user-owned table has an `owner_id` with Row Level Security from day one, so family members can be added later (enable invites, small settings UI) without migration. Market data, checks, data health and the strategy library are shared per instance. Provider keys stay instance-level. Note: Tiingo's free plan is internal use; household use is a gray area, wider use needs per-person instances or a data-plan upgrade.
- **Hosted as a portfolio project:** the owner's instance is private (login required); public visitors see a demo mode with synthetic data.
- **Self-hostable:** others can fork and run their own instance with their own API keys (BYOK).
- **Commercial use** is not a goal; it may only be considered as a consequence of success.

## Audience
The owner first; designed so an individual with little investment knowledge can use it, in English or Japanese.

## Benchmark set
Judged in yen, after tax and costs, against what an individual in Japan would realistically hold. Index benchmarks are assumed held in **NISA** (tax-free), because that is the realistic alternative:
- S&P 500 index fund in NISA (modeled with SPY in yen minus fee)
- Global index fund in NISA (eMAXIS Slim All Country; modeled with VT in yen minus fee)
- Balanced 8-asset fund in NISA (ETF composite, defined in C2)
- Robo-advisor style portfolio (ETF mix, defined in C2)
- Gold (GLD in yen)
- Bank deposits (actual current JPY deposit rate)

## Outcome targets
Targets apply to a **strategy slice**, not the whole portfolio (the user may hold e.g. 50% in a safe core and 10% in an aggressive strategy). Measured on the **median rolling 5-year window**, with the share of windows meeting the target and a confidence range always reported. Backtests use next-day execution, realistic costs and tax.

| Tier | Target |
|---|---|
| Aggressive (default) | Beat S&P 500 buy and hold held in NISA by 5-10pp per year in yen after tax and costs, with max drawdown no worse than S&P 500's and higher Sharpe and Calmar ratios |
| Balanced | Match All Country (NISA) return with at most 60% of its max drawdown |
| Conservative | Beat the balanced 8-asset fund (NISA) with no worse max drawdown |

Initial evidence for the aggressive target: `docs/evidence/backtests.md` (pre-tax, same-close execution; re-run with next-day execution and tax at TR1). Whole-portfolio targets are defined at F5.

## Pillar targets
| Pillar | Target | Measurement |
|---|---|---|
| Reliability | 100% of injected material faults detected (faults larger than the relevant tolerance); zero normal signals presented on red data | Fault-injection suite (CI); audit log |
| Reliability (process) | Data status green on ≥ 99% of trading days (yellow and red tracked separately) | Data-health history |
| Evidence | 100% of library strategies cite research and show tamper-evident post-registration results | Library review; chain verification |
| Decision clarity | ≥ 4 of 5 test users correctly state a strategy's bad-case loss in yen after reading its page | Usability test (3-5 people) |
| Decision clarity | 100% coverage of the information-parity metric set for every strategy | Automated check |
| Accessibility | 100% tooltip coverage; on a deployed instance, a novice reaches a first strategy in < 15 minutes | CI check; usability test |
| Accessibility (language) | 100% of user-facing strings exist in EN and JA | CI check (enforced from D1) |
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


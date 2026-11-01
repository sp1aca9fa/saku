**Status: Proposal, not approved.** Written 2026-11-01 for the owner's approval before the library is seeded (stage B2, requirements 09 "Strategy library"). Nothing here is registered. No backtest was run to write it and it contains no performance numbers.

# Strategy library (proposal)

12 families, 63 variants (59 expressible with today's engine, 4 waiting for a feature). Each family says what it does, the tickers it needs, its research basis, its caveats, its variants and a YAML sketch of its first variant in the current schema (`docs/indicators.md`, `templates/strategies/setup-1.yaml`).

## How to read the citations

Written without web access. Every citation is marked **to verify**, with the exact claim it is cited for. Before seeding, each one is checked against the paper itself; a citation whose claim does not hold is removed, and its family goes back to the owner. No page numbers and no reported results are quoted, so none can be wrong.

## Conventions for every sketch (choices, each with its reason)

| Convention | Choice | Reason |
|---|---|---|
| Account | `taxable` | Every regime defines it (05); timing strategies switch, which tax-advantaged quotas suit poorly. |
| Execution | `next_open` | The default (05); `same_close` is not achievable. |
| Evaluation | `daily` | The only frequency the engine runs today; weekly and monthly wait for C31 (1). |
| Costs | `slippageBps: 5`, fees and FX spread from the install's broker settings | As in Setup 1's template; never tuned. |
| Signal series | Total return (`totalReturn: true`) | Dividends count, and a split cannot flip a signal (C18). |
| Cash | `CASH_USD` | The only cash the engine has today; `CASH_BASE` versions are a decision-card choice, not separate variants. |
| Ensemble threshold | 0.5 (2 of 3 members) | A majority; the same in every family so it adds no trials. |
| Moving-average sets | E1 = SMA 150, 200, 250; E2 = SMA 100, 200, 300 | Both centered on 200 days (about the 10 months of Faber 2007 and the 200 days of Gayed and Bilello 2016); E2 is wider. Not chosen from any backtest. |
| Tolerance | 0 (the papers' plain rule) or 3% (Setup 1's) | Used only where the reference value is always positive (a fund against its own average, a volatility against a positive level); see Q4. |
| Safe state | 1x of the underlying (SPY; QQQ for the Nasdaq family; the equal mix for family 9) | Requirements 04 make 1x the default for leveraged strategies. For 1x strategies this is Q2. |
| Leveraged funds | Real funds (SSO, UPRO, QLD, TQQQ) in the sketches | What a user can buy; how history before a fund's start is filled is Q1. SPXL is interchangeable with UPRO and is not a separate variant (it would add a trial with no new idea). |

Leaving the strategy's own costs out lets the install's broker settings apply (05, C2).

## Caveats that apply to every family

- **Post-publication decay.** McLean and Pontiff (2016) (to verify: that returns of published predictors are lower after publication than in the papers' samples) is the reason to assume every edge here is smaller in the future than in its backtest. Library strategies are judged on post-registration results (09).
- **Selection bias and multiple testing.** The families were picked by someone who knows how the last 30 years went (the 2009-2021 bull market favors leverage; the Nasdaq-100 is chosen knowing it did well). Harvey, Liu and Zhu (2016) (to verify: that many tested strategies make conventional significance thresholds too lenient) and Bailey and López de Prado (2014) (to verify: that the best Sharpe ratio among many trials is inflated, and how to deflate it) apply. All registered variants, plus the owner's earlier testfol runs (`docs/evidence/backtests.md`), count as trials in the deflated Sharpe ratio and the robustness score (`docs/robustness-score.md`).
- **One history.** About six non-overlapping 5-year windows exist for SPY, fewer for younger funds. Crisis coverage depends on each ticker's start (03): IEF and TLT from 2002, GLD from 2004, UPRO from 2009.
- **Tax and FX.** In a taxable account, each switch that sells at a gain realizes tax at the regime's flat rate (Japan: 20.315%, the cost model of requirements 09 before C1); more switches mean more tax drag. All funds are USD funds, so yen results also carry FX.
- **Daily evaluation.** The papers mostly evaluate monthly; checked daily, the same rule switches more often (more costs and tax). Monthly twins wait for C31 (1).
- **No rebalancing inside an allocation.** Weights are set at each switch and then drift until the allocation changes (`docs/indicators.md`, an assumption until testfol parity). A multi-fund allocation held for years drifts away from its stated weights. This matters most for family 9.

## Families

### 1. Trend filter, S&P 500, 1x

- **What it does:** holds SPY while its total-return price is above its long moving averages (a majority of three), else USD cash.
- **Tickers:** SPY, cash. History from 1993.
- **Research basis (to verify):** Faber, Mebane T. (2007). "A Quantitative Approach to Tactical Asset Allocation." _The Journal of Wealth Management_ 9(4). Claim: holding an asset only while its price is above its 10-month simple moving average, else Treasury bills, gave lower volatility and smaller drawdowns than buy and hold over the paper's sample. Hurst, Brian, Yao Hua Ooi, and Lasse Heje Pedersen (2017). "A Century of Evidence on Trend-Following Investing." _The Journal of Portfolio Management_ 44(1). Claim: trend following was profitable over a long history across many markets.
- **Caveats:** the paper uses monthly evaluation and a 10-month average; this is the daily 200-day version. Trend filters lag: they lose in fast V-shaped crashes and whipsaw in flat markets. In long bull markets they trail buy and hold (time in cash).
- **Variants (5):** E1 or E2, tolerance 0 or 3% (4); the single SMA 200, tolerance 0 (1, the literature's form, kept as a reference point).

```yaml
name: 'Trend 1x: SPY above its 150/200/250-day averages, else cash (tolerance 3%)'
account: taxable
execution: next_open
safeState:
  holdings:
    - { ticker: SPY, weight: 100 }
evaluation: { frequency: daily }
costs: { slippageBps: 5 }
signals:
  - id: trend
    type: ensemble
    members:
      - left: { indicator: price, ticker: SPY, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: SPY, length: 150, totalReturn: true }
        tolerancePct: 3
      - left: { indicator: price, ticker: SPY, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: SPY, length: 200, totalReturn: true }
        tolerancePct: 3
      - left: { indicator: price, ticker: SPY, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: SPY, length: 250, totalReturn: true }
        tolerancePct: 3
    threshold: 0.5
allocations:
  - name: Stocks
    when: { all: [trend] }
    holdings:
      - { ticker: SPY, weight: 100 }
  - name: Cash
    holdings:
      - { ticker: CASH_USD, weight: 100 }
```

### 2. Trend filter with a filtered bond fallback

- **What it does:** SPY while its trend is up; otherwise Treasuries (IEF or TLT) while the bonds' own trend is up; otherwise cash (the "filtered fallback" of requirements 05).
- **Tickers:** SPY, IEF or TLT, cash. Full history from 2002 (the bond funds' start), so the 2000-02 crash is not covered.
- **Research basis (to verify):** Faber (2007), as in family 1. Claim: the same moving-average rule applied to each asset class (bonds included) on its own.
- **Caveats:** stocks and bonds fell together in 2022; the bonds' own trend filter is what is meant to catch that, and it lags. TLT is about twice as rate-sensitive as IEF.
- **Variants (4):** IEF or TLT, tolerance 0 or 3%; E1 for both trends.

```yaml
name: 'Trend 1x with bonds: SPY on trend, else IEF on its own trend, else cash'
account: taxable
execution: next_open
safeState:
  holdings:
    - { ticker: SPY, weight: 100 }
evaluation: { frequency: daily }
costs: { slippageBps: 5 }
signals:
  - id: stocks
    type: ensemble
    members:
      - left: { indicator: price, ticker: SPY, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: SPY, length: 150, totalReturn: true }
      - left: { indicator: price, ticker: SPY, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: SPY, length: 200, totalReturn: true }
      - left: { indicator: price, ticker: SPY, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: SPY, length: 250, totalReturn: true }
    threshold: 0.5
  - id: bonds
    type: ensemble
    members:
      - left: { indicator: price, ticker: IEF, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: IEF, length: 150, totalReturn: true }
      - left: { indicator: price, ticker: IEF, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: IEF, length: 200, totalReturn: true }
      - left: { indicator: price, ticker: IEF, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: IEF, length: 250, totalReturn: true }
    threshold: 0.5
allocations:
  - name: Stocks
    when: { all: [stocks] }
    holdings:
      - { ticker: SPY, weight: 100 }
  - name: Bonds
    when: { all: [bonds] }
    holdings:
      - { ticker: IEF, weight: 100 }
  - name: Cash
    holdings:
      - { ticker: CASH_USD, weight: 100 }
```

### 3. Leveraged trend, S&P 500 (2x or 3x)

- **What it does:** holds a 2x or 3x S&P 500 fund while SPY's trend is up, else cash.
- **Tickers:** SPY (signal), SSO or UPRO, cash. Real funds from 2006 (SSO) and 2009 (UPRO); earlier history needs Q1.
- **Research basis (to verify):** Gayed, Michael A., and Charles V. Bilello (2016). "Leverage for the Long Run: A Systematic Approach to Managing Risk and Magnifying Returns in Stocks." SSRN working paper. Claim: holding leveraged S&P 500 exposure only while the index is above its 200-day moving average (else Treasury bills) did better than buy-and-hold leverage over the paper's sample, because volatility tends to be lower and returns more persistent above the average. Cheng, Minder, and Ananth Madhavan (2009). "The Dynamics of Leveraged and Inverse Exchange-Traded Funds." _Journal of Investment Management_ 7(4). Claim: daily-reset leveraged funds compound away from L times the index over longer periods, losing in volatile, trendless markets.
- **Caveats:** a 3x fund can lose most of its value in a crash that the filter reacts to late (one fast gap is enough). The leverage cost depends on short-term rates, which were near zero for much of 2009-2021. The paper's result comes from one market and one sample.
- **Variants (8):** SSO or UPRO; E1 or E2; tolerance 0 or 3%.

```yaml
name: 'Leveraged trend: UPRO while SPY is above its 150/200/250-day averages, else cash'
account: taxable
execution: next_open
safeState:
  holdings:
    - { ticker: SPY, weight: 100 }
evaluation: { frequency: daily }
costs: { slippageBps: 5 }
signals:
  - id: trend
    type: ensemble
    members:
      - left: { indicator: price, ticker: SPY, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: SPY, length: 150, totalReturn: true }
        tolerancePct: 3
      - left: { indicator: price, ticker: SPY, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: SPY, length: 200, totalReturn: true }
        tolerancePct: 3
      - left: { indicator: price, ticker: SPY, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: SPY, length: 250, totalReturn: true }
        tolerancePct: 3
    threshold: 0.5
allocations:
  - name: Leveraged
    when: { all: [trend] }
    holdings:
      - { ticker: UPRO, weight: 100 }
  - name: Cash
    holdings:
      - { ticker: CASH_USD, weight: 100 }
```

### 4. Trend and calm volatility (the Setup 1 family)

- **What it does:** leverage while SPY's trend is up and its recent volatility is low; 1x SPY while the trend is up but volatility is high; otherwise cash.
- **Tickers:** SPY, SSO or UPRO, cash.
- **Research basis (to verify):** Faber (2007) and Gayed and Bilello (2016) for the trend part, as above. Moreira, Alan, and Tyler Muir (2017). "Volatility-Managed Portfolios." _The Journal of Finance_ 72(4). Claim: lowering exposure when recent realized volatility is high raised risk-adjusted returns of the market portfolio over the paper's sample, because high volatility was not followed by proportionally higher returns. Cheng and Madhavan (2009) for the leverage decay.
- **Caveats:** the paper scales exposure continuously and monthly; a yes/no volatility gate checked daily is a coarse version of it. The owner's Setup 1 parameters (one 20-day volatility, threshold 25, tolerance 3%) were chosen after seeing results (`docs/evidence/backtests.md`); Setup 2 was picked because it looked best and is left out for that reason.
- **Variants (7):** the "calm" signal is an ensemble of the 20-, 40- and 60-day volatility below a level of 20, 25 or 30 (percent a year), with SSO or UPRO (6); plus Setup 1 as written in `templates/strategies/setup-1.yaml` (1, labeled as chosen after seeing results).

```yaml
name: 'Trend and calm: UPRO on trend and calm, SPY on trend only, else cash (volatility below 25)'
account: taxable
execution: next_open
safeState:
  holdings:
    - { ticker: SPY, weight: 100 }
evaluation: { frequency: daily }
costs: { slippageBps: 5 }
signals:
  - id: trend
    type: ensemble
    members:
      - left: { indicator: price, ticker: SPY, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: SPY, length: 150, totalReturn: true }
        tolerancePct: 3
      - left: { indicator: price, ticker: SPY, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: SPY, length: 200, totalReturn: true }
        tolerancePct: 3
      - left: { indicator: price, ticker: SPY, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: SPY, length: 250, totalReturn: true }
        tolerancePct: 3
    threshold: 0.5
  - id: calm
    type: ensemble
    members:
      - left: { indicator: volatility, ticker: SPY, length: 20, totalReturn: true }
        op: '<'
        right: { threshold: 25 }
      - left: { indicator: volatility, ticker: SPY, length: 40, totalReturn: true }
        op: '<'
        right: { threshold: 25 }
      - left: { indicator: volatility, ticker: SPY, length: 60, totalReturn: true }
        op: '<'
        right: { threshold: 25 }
    threshold: 0.5
allocations:
  - name: Risk on
    when: { all: [trend, calm] }
    holdings:
      - { ticker: UPRO, weight: 100 }
  - name: Trend only
    when: { all: [trend] }
    holdings:
      - { ticker: SPY, weight: 100 }
  - name: Cash
    holdings:
      - { ticker: CASH_USD, weight: 100 }
```

### 5. Volatility steps (volatility targeting with fixed steps)

- **What it does:** picks 3x, 2x, 1x or cash from SPY's recent volatility, so that leverage x volatility stays at or below a target T: 3x when volatility is below T/3, 2x below T/2, 1x below T, else cash. No trend signal.
- **Tickers:** SPY, SSO, UPRO, cash.
- **Research basis (to verify):** Moreira and Muir (2017), as in family 4. Harvey, Campbell R., Edward Hoyle, Russell Korgaonkar, Sandy Rattray, Matthew Sargaison, and Otto Van Hemert (2018). "The Impact of Volatility Targeting." _The Journal of Portfolio Management_ 45(1). Claim: targeting a constant volatility reduces the likelihood of extreme returns for risk assets such as equities.
- **Caveats:** the real feature is exposure scaling (C31 (3)); this is an approximation with an allocation chain, rounding leverage down to the nearest step. Daily volatility crossings can cause many switches (the finder's limit is 12 a year). The 3x step needs volatility below T/3, which is rare.
- **Variants (6):** T = 15, 20 or 25 (percent a year; around what an investor would call the S&P 500's ordinary volatility, not taken from a backtest), with the 20- or 60-day volatility. Levels are T/3 and T/2 rounded to 2 decimals.

```yaml
name: 'Volatility steps: target 20% a year with 3x/2x/1x/cash from 20-day volatility'
account: taxable
execution: next_open
safeState:
  holdings:
    - { ticker: SPY, weight: 100 }
evaluation: { frequency: daily }
costs: { slippageBps: 5 }
signals:
  - id: below3
    type: compare
    left: { indicator: volatility, ticker: SPY, length: 20, totalReturn: true }
    op: '<'
    right: { threshold: 6.67 }
  - id: below2
    type: compare
    left: { indicator: volatility, ticker: SPY, length: 20, totalReturn: true }
    op: '<'
    right: { threshold: 10 }
  - id: below1
    type: compare
    left: { indicator: volatility, ticker: SPY, length: 20, totalReturn: true }
    op: '<'
    right: { threshold: 20 }
allocations:
  - name: 3x
    when: { all: [below3] }
    holdings:
      - { ticker: UPRO, weight: 100 }
  - name: 2x
    when: { all: [below2] }
    holdings:
      - { ticker: SSO, weight: 100 }
  - name: 1x
    when: { all: [below1] }
    holdings:
      - { ticker: SPY, weight: 100 }
  - name: Cash
    holdings:
      - { ticker: CASH_USD, weight: 100 }
```

### 6. Time-series momentum (absolute momentum), S&P 500

- **What it does:** holds SPY (or UPRO) while its total return over the last 3, 6 and 12 months is positive (a majority of three), else cash or IEF.
- **Tickers:** SPY, UPRO, IEF, cash.
- **Research basis (to verify):** Moskowitz, Tobias J., Yao Hua Ooi, and Lasse Heje Pedersen (2012). "Time Series Momentum." _Journal of Financial Economics_ 104(2). Claim: an instrument's own past 12-month excess return predicted its next month's return across a broad set of futures and forwards (equity indices included).
- **Caveats:** the paper uses excess returns over T-bills, across many markets at once, monthly. Here: total return above 0 on one index, daily. When cash pays 5% a year, "above 0" is a weaker test than "above cash" (an operand for the cash rate does not exist; see Q5). A level of exactly 0 meets the open near-tie question C27. No tolerance (Q4).
- **Variants (5):** SPY or UPRO, with cash or IEF as the fallback (4); plus the single 12-month (252-day) return, SPY, cash (1, the paper's main lookback).

```yaml
name: 'Absolute momentum: SPY while its 3/6/12-month total return is positive, else cash'
account: taxable
execution: next_open
safeState:
  holdings:
    - { ticker: SPY, weight: 100 }
evaluation: { frequency: daily }
costs: { slippageBps: 5 }
signals:
  - id: momentum
    type: ensemble
    members:
      - left: { indicator: return, ticker: SPY, length: 63, totalReturn: true }
        op: '>'
        right: { threshold: 0 }
      - left: { indicator: return, ticker: SPY, length: 126, totalReturn: true }
        op: '>'
        right: { threshold: 0 }
      - left: { indicator: return, ticker: SPY, length: 252, totalReturn: true }
        op: '>'
        right: { threshold: 0 }
    threshold: 0.5
allocations:
  - name: Stocks
    when: { all: [momentum] }
    holdings:
      - { ticker: SPY, weight: 100 }
  - name: Cash
    holdings:
      - { ticker: CASH_USD, weight: 100 }
```

### 7. Dual momentum, adapted to the Tier 0 universe

- **What it does:** if SPY's 12-month total return is positive, holds whichever of QQQ and SPY had the higher 12-month total return; otherwise IEF (or TLT).
- **Tickers:** SPY, QQQ, IEF or TLT. Full history from 2002.
- **Research basis (to verify):** Antonacci, Gary (2014). _Dual Momentum Investing: An Innovative Strategy for Higher Returns with Lower Risk._ McGraw-Hill Education. Claim: combining relative momentum (hold the stronger of US and non-US stocks) with absolute momentum (hold stocks only while their 12-month return beats T-bills, else bonds).
- **Caveats:** this is not the book's model. The book compares US with non-US stocks (two markets that diverge) and uses an aggregate bond fund; Tier 0 has neither, and QQQ and SPY move closely together, so the relative part adds less. The faithful version needs EFA and AGG (Tier 1, C2) and monthly evaluation (C31 (1)). "Above 0" stands in for "above T-bills" (Q5) and meets C27. No tolerance on return comparisons (Q4).
- **Variants (4):** IEF or TLT as the fallback; a single 252-day lookback, or an ensemble of 126, 189 and 252 days for both parts.

```yaml
name: 'Dual momentum (adapted): stronger of QQQ and SPY while SPY 12-month return is positive, else IEF'
account: taxable
execution: next_open
safeState:
  holdings:
    - { ticker: SPY, weight: 100 }
evaluation: { frequency: daily }
costs: { slippageBps: 5 }
signals:
  - id: absolute
    type: compare
    left: { indicator: return, ticker: SPY, length: 252, totalReturn: true }
    op: '>'
    right: { threshold: 0 }
  - id: nasdaqStronger
    type: compare
    left: { indicator: return, ticker: QQQ, length: 252, totalReturn: true }
    op: '>'
    right: { indicator: return, ticker: SPY, length: 252, totalReturn: true }
allocations:
  - name: Nasdaq-100
    when: { all: [absolute, nasdaqStronger] }
    holdings:
      - { ticker: QQQ, weight: 100 }
  - name: S&P 500
    when: { all: [absolute] }
    holdings:
      - { ticker: SPY, weight: 100 }
  - name: Bonds
    holdings:
      - { ticker: IEF, weight: 100 }
```

### 8. Trend filter, Nasdaq-100 (1x, 2x or 3x)

- **What it does:** holds QQQ, QLD or TQQQ while QQQ's trend is up, else cash.
- **Tickers:** QQQ (signal), QLD or TQQQ, cash. QQQ from 1999 (covers the 2000-02 crash); QLD from 2006, TQQQ from 2010 (Q1).
- **Research basis (to verify):** Faber (2007) and Gayed and Bilello (2016), as above, for the rule. Neither tests the Nasdaq-100; applying it there is an extension, not a published result.
- **Caveats:** the strongest hindsight bias in this list: the Nasdaq-100 is included because it did well. Fewer, more concentrated holdings than the S&P 500; it fell much further in 2000-02. 3x on it has the largest decay and crash risk here.
- **Variants (6):** QQQ, QLD or TQQQ; E1 or E2; tolerance 0.

```yaml
name: 'Nasdaq-100 trend: TQQQ while QQQ is above its 150/200/250-day averages, else cash'
account: taxable
execution: next_open
safeState:
  holdings:
    - { ticker: QQQ, weight: 100 }
evaluation: { frequency: daily }
costs: { slippageBps: 5 }
signals:
  - id: trend
    type: ensemble
    members:
      - left: { indicator: price, ticker: QQQ, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: QQQ, length: 150, totalReturn: true }
      - left: { indicator: price, ticker: QQQ, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: QQQ, length: 200, totalReturn: true }
      - left: { indicator: price, ticker: QQQ, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: QQQ, length: 250, totalReturn: true }
    threshold: 0.5
allocations:
  - name: Leveraged
    when: { all: [trend] }
    holdings:
      - { ticker: TQQQ, weight: 100 }
  - name: Cash
    holdings:
      - { ticker: CASH_USD, weight: 100 }
```

### 9. Three-asset trend (stocks, bonds, gold)

- **What it does:** a third each in SPY, IEF (or TLT) and GLD; each third is held only while that fund's own trend is up, else it sits in cash. Meant for the conservative and balanced tiers.
- **Tickers:** SPY, IEF or TLT, GLD, cash. Full history from 2004 (GLD).
- **Research basis (to verify):** Faber (2007). Claim: the moving-average rule applied to each of several asset classes, each with an equal share, gave lower volatility and drawdowns than the equal-weight buy-and-hold mix over the paper's sample.
- **Caveats:** the paper uses five asset classes and monthly rebalancing; here three, and no rebalancing while the allocation stays the same (weights drift; see the general caveats and Q3). Every on/off combination needs its own allocation (8), which is long but exact; ranked blocks or per-sleeve rules would shorten it. The first third is 33.34% so the weights add to 100.
- **Variants (4):** IEF or TLT; the E1 ensemble or a single SMA 200 per fund.

```yaml
name: 'Three-asset trend: SPY, IEF, GLD a third each, each only on its own trend, else cash'
account: taxable
execution: next_open
safeState:
  holdings:
    - { ticker: SPY, weight: 33.34 }
    - { ticker: IEF, weight: 33.33 }
    - { ticker: GLD, weight: 33.33 }
evaluation: { frequency: daily }
costs: { slippageBps: 5 }
signals:
  - id: s
    type: ensemble
    members:
      - left: { indicator: price, ticker: SPY, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: SPY, length: 150, totalReturn: true }
      - left: { indicator: price, ticker: SPY, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: SPY, length: 200, totalReturn: true }
      - left: { indicator: price, ticker: SPY, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: SPY, length: 250, totalReturn: true }
    threshold: 0.5
  - id: b
    type: ensemble
    members:
      - left: { indicator: price, ticker: IEF, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: IEF, length: 150, totalReturn: true }
      - left: { indicator: price, ticker: IEF, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: IEF, length: 200, totalReturn: true }
      - left: { indicator: price, ticker: IEF, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: IEF, length: 250, totalReturn: true }
    threshold: 0.5
  - id: g
    type: ensemble
    members:
      - left: { indicator: price, ticker: GLD, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: GLD, length: 150, totalReturn: true }
      - left: { indicator: price, ticker: GLD, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: GLD, length: 200, totalReturn: true }
      - left: { indicator: price, ticker: GLD, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: GLD, length: 250, totalReturn: true }
    threshold: 0.5
allocations:
  - name: All three
    when: { all: [s, b, g] }
    holdings:
      - { ticker: SPY, weight: 33.34 }
      - { ticker: IEF, weight: 33.33 }
      - { ticker: GLD, weight: 33.33 }
  - name: Stocks and bonds
    when: { all: [s, b], none: [g] }
    holdings:
      - { ticker: SPY, weight: 33.34 }
      - { ticker: IEF, weight: 33.33 }
      - { ticker: CASH_USD, weight: 33.33 }
  - name: Stocks and gold
    when: { all: [s, g], none: [b] }
    holdings:
      - { ticker: SPY, weight: 33.34 }
      - { ticker: GLD, weight: 33.33 }
      - { ticker: CASH_USD, weight: 33.33 }
  - name: Bonds and gold
    when: { all: [b, g], none: [s] }
    holdings:
      - { ticker: IEF, weight: 33.33 }
      - { ticker: GLD, weight: 33.33 }
      - { ticker: CASH_USD, weight: 33.34 }
  - name: Stocks only
    when: { all: [s], none: [b, g] }
    holdings:
      - { ticker: SPY, weight: 33.34 }
      - { ticker: CASH_USD, weight: 66.66 }
  - name: Bonds only
    when: { all: [b], none: [s, g] }
    holdings:
      - { ticker: IEF, weight: 33.33 }
      - { ticker: CASH_USD, weight: 66.67 }
  - name: Gold only
    when: { all: [g], none: [s, b] }
    holdings:
      - { ticker: GLD, weight: 33.33 }
      - { ticker: CASH_USD, weight: 66.67 }
  - name: Cash
    holdings:
      - { ticker: CASH_USD, weight: 100 }
```

### 10. Moving-average crossovers, S&P 500

- **What it does:** holds SPY (or UPRO) while a short average of SPY is above a long one, by a majority of three pairs (5 over 150 days, 2 over 200 days, 50 over 200 days), else cash.
- **Tickers:** SPY, UPRO, cash.
- **Research basis (to verify):** Brock, William, Josef Lakonishok, and Blake LeBaron (1992). "Simple Technical Trading Rules and the Stochastic Properties of Stock Returns." _The Journal of Finance_ 47(5). Claim: moving-average rules on a US stock index (including the 1-150, 5-150, 1-200 and 2-200 day pairs) produced return differences between buy and sell days that standard return models did not explain, over the paper's sample. Sullivan, Ryan, Allan Timmermann, and Halbert White (1999). "Data-Snooping, Technical Trading Rule Performance, and the Bootstrap." _The Journal of Finance_ 54(5). Claim: after accounting for the many rules that could have been tried, the best rules' advantage did not carry over to the period after the original sample.
- **Caveats:** the second paper is the main caveat: this family is included as a check on the trend idea, with that warning shown. The 50/200 pair is common practice, not from either paper.
- **Variants (4):** simple or exponential averages; SPY or UPRO.

```yaml
name: 'Crossovers: SPY while short averages are above long ones (5/150, 2/200, 50/200), else cash'
account: taxable
execution: next_open
safeState:
  holdings:
    - { ticker: SPY, weight: 100 }
evaluation: { frequency: daily }
costs: { slippageBps: 5 }
signals:
  - id: crossover
    type: ensemble
    members:
      - left: { indicator: sma, ticker: SPY, length: 5, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: SPY, length: 150, totalReturn: true }
      - left: { indicator: sma, ticker: SPY, length: 2, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: SPY, length: 200, totalReturn: true }
      - left: { indicator: sma, ticker: SPY, length: 50, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: SPY, length: 200, totalReturn: true }
    threshold: 0.5
allocations:
  - name: Stocks
    when: { all: [crossover] }
    holdings:
      - { ticker: SPY, weight: 100 }
  - name: Cash
    holdings:
      - { ticker: CASH_USD, weight: 100 }
```

### 11. Leverage with a drawdown stop

- **What it does:** leverage while SPY's trend is up and SPY is less than X% below its highest value of the last year; 1x SPY while the trend is up but the drawdown is deeper; otherwise cash.
- **Tickers:** SPY, SSO or UPRO, cash.
- **Research basis (to verify):** Kaminski, Kathryn M., and Andrew W. Lo (2014). "When Do Stop-Loss Rules Stop Losses?" _Journal of Financial Markets_ 18. Claim: a rule that moves out of stocks after a loss adds value when returns have momentum or regime changes, and costs return when prices follow a random walk. Gayed and Bilello (2016) for the trend part.
- **Caveats:** this uses the underlying's drawdown, not the strategy's own equity (that is the circuit breaker, C31 (4)). Drawdown and trend overlap; the stop mostly acts in fast falls before the averages turn. No tolerance on the negative drawdown level (Q4), so it can switch often near X.
- **Variants (6):** X = 10, 15 or 20 (a correction, a deeper correction, the usual bear-market line; conventions, not fitted); SSO or UPRO.

```yaml
name: 'Drawdown stop: UPRO on trend while SPY is within 10% of its 1-year high, SPY on trend, else cash'
account: taxable
execution: next_open
safeState:
  holdings:
    - { ticker: SPY, weight: 100 }
evaluation: { frequency: daily }
costs: { slippageBps: 5 }
signals:
  - id: trend
    type: ensemble
    members:
      - left: { indicator: price, ticker: SPY, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: SPY, length: 150, totalReturn: true }
        tolerancePct: 3
      - left: { indicator: price, ticker: SPY, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: SPY, length: 200, totalReturn: true }
        tolerancePct: 3
      - left: { indicator: price, ticker: SPY, totalReturn: true }
        op: '>'
        right: { indicator: sma, ticker: SPY, length: 250, totalReturn: true }
        tolerancePct: 3
    threshold: 0.5
  - id: shallow
    type: compare
    left: { indicator: drawdown, ticker: SPY, length: 252, totalReturn: true }
    op: '>'
    right: { threshold: -10 }
allocations:
  - name: Leveraged
    when: { all: [trend, shallow] }
    holdings:
      - { ticker: UPRO, weight: 100 }
  - name: Trend only
    when: { all: [trend] }
    holdings:
      - { ticker: SPY, weight: 100 }
  - name: Cash
    holdings:
      - { ticker: CASH_USD, weight: 100 }
```

### 12. Relative-strength rotation (needs ranked blocks, pending decision C31 (2))

- **What it does:** from SPY, QQQ, IEF, TLT and GLD, holds the 1 (or 2, equal weights) with the highest total return over the lookback, each only while its own return is positive; else cash.
- **Tickers:** SPY, QQQ, IEF, TLT, GLD, cash. Full history from 2004.
- **Research basis (to verify):** Faber, Mebane T. (2010). "Relative Strength Strategies for Investing." SSRN working paper. Claim: rotating among asset classes into those with the strongest recent returns did better than equal weighting over the paper's sample. Antonacci (2014) for the absolute filter.
- **Caveats:** IEF and TLT overlap (both Treasuries), so the universe is effectively four. Top-1 rotation is concentrated. A top-1 version could be written today with pairwise return comparisons, but it would be long and its tolerance states could disagree with each other; waiting for ranked blocks is cleaner.
- **Variants (4, not registered until C31 (2) is built):** top 1 or top 2; 126-day or 252-day return.
- **YAML:** needs ranked blocks, pending decision C31 (2).

## Variants by feature

| Feature | Status | Families |
|---|---|---|
| Compare, ensemble, and/or/not signals; allocation chains; fixed weights | Built | 1-11 |
| `return`, `volatility` (close), `drawdown`, `sma`, `ema` | Built | 5, 6, 7, 10, 11 |
| Weekly or monthly evaluation (C31 (1)) | Pending | Monthly twins of 1, 6, 7 and 9 would follow the papers more closely; proposed as 8 later variants (total then 71) |
| Ranked blocks (C31 (2)) | Pending | 12 |
| Exposure scaling (C31 (3)) | Pending | 5 would use it instead of the chain |
| Circuit breaker (C31 (4)) | Pending | None; 11 uses the underlying's drawdown instead |
| `delayDays` (C30), N-day breakouts (C33), range volatilities (C32) | Pending | None proposed |
| Return above cash (no operand for the cash rate) | Not in requirements (Q5) | 6, 7 use "above 0" |

## Open questions for the owner

- **Q1. History before a leveraged fund existed.** Requirements 03 say earlier periods use synthetic leverage, but not how. Proposal: library strategies hold the real fund; their backtests use the synthetic twin (`SPY?L=3&E=0.9`, E = the fund's expense ratio) before the fund's first day and the real fund after, labeled in every result. Without it, a UPRO strategy's history starts in 2009 and misses the 2000-02 and 2008 crises. Recommendation: yes.
- **Q2. Safe state of 1x strategies.** 04 fixes 1x of the underlying for leveraged strategies. For a 1x strategy that is in cash, that means buying SPY on a red-data day. Proposal: the same 1x rule for all (one rule; never more risk than the benchmark). The alternative, cash, never adds risk but sells at a gain on a red day (tax in a taxable account). Recommendation: 1x for all.
- **Q3. Rebalancing within an allocation.** Family 9's thirds drift for as long as the allocation holds. Recommendation: settle it with C31 (1) (rebalance at each weekly or monthly evaluation), and register family 9 only after that.
- **Q4. Tolerance with a negative or zero reference value (found while writing this).** The tolerance band is ref x (1 + t/100) and ref x (1 - t/100). When ref is negative (a drawdown level of -10, or another fund's return that is below 0) the two bounds swap: the engine then compares with ref x (1 + t/100) alone, so the threshold moves and there is no band. When ref is 0 the band has no width. The sketches avoid tolerance there. Recommendation: refuse a tolerance on a comparison whose reference can be 0 or negative (fixed levels <= 0, and `return` or `drawdown` operands), or define the band in percentage points for percent indicators; to decide with testfol parity.
- **Q5. "Above cash".** Absolute momentum is defined against T-bills. There is no operand for the cash rate's return. Recommendation: keep "above 0" for now, labeled; a cash-return operand is a backlog idea.
- **Q6. Family 7 (adapted dual momentum) and family 8 (Nasdaq-100).** Both are weaker on evidence than the rest (7 is a loose adaptation, 8 is mostly hindsight). Recommendation: keep both, labeled as such, since the finder and forward records will judge them; drop 8 if you prefer the library to hold only what a paper tested.
- **Q7. Variant count.** 59 now (63 with family 12). Each variant is a trial that lowers every variant's statistical confidence. Recommendation: keep this size; do not add variants without removing others.

## References (all to verify)

- Antonacci, Gary (2014). _Dual Momentum Investing: An Innovative Strategy for Higher Returns with Lower Risk._ McGraw-Hill Education.
- Bailey, David H., and Marcos López de Prado (2014). "The Deflated Sharpe Ratio: Correcting for Selection Bias, Backtest Overfitting, and Non-Normality." _The Journal of Portfolio Management_ 40(5).
- Brock, William, Josef Lakonishok, and Blake LeBaron (1992). "Simple Technical Trading Rules and the Stochastic Properties of Stock Returns." _The Journal of Finance_ 47(5).
- Cheng, Minder, and Ananth Madhavan (2009). "The Dynamics of Leveraged and Inverse Exchange-Traded Funds." _Journal of Investment Management_ 7(4).
- Faber, Mebane T. (2007). "A Quantitative Approach to Tactical Asset Allocation." _The Journal of Wealth Management_ 9(4).
- Faber, Mebane T. (2010). "Relative Strength Strategies for Investing." SSRN working paper.
- Gayed, Michael A., and Charles V. Bilello (2016). "Leverage for the Long Run: A Systematic Approach to Managing Risk and Magnifying Returns in Stocks." SSRN working paper.
- Harvey, Campbell R., Edward Hoyle, Russell Korgaonkar, Sandy Rattray, Matthew Sargaison, and Otto Van Hemert (2018). "The Impact of Volatility Targeting." _The Journal of Portfolio Management_ 45(1).
- Harvey, Campbell R., Yan Liu, and Heqing Zhu (2016). "... and the Cross-Section of Expected Returns." _The Review of Financial Studies_ 29(1).
- Hurst, Brian, Yao Hua Ooi, and Lasse Heje Pedersen (2017). "A Century of Evidence on Trend-Following Investing." _The Journal of Portfolio Management_ 44(1).
- Kaminski, Kathryn M., and Andrew W. Lo (2014). "When Do Stop-Loss Rules Stop Losses?" _Journal of Financial Markets_ 18.
- McLean, R. David, and Jeffrey Pontiff (2016). "Does Academic Research Destroy Stock Return Predictability?" _The Journal of Finance_ 71(1).
- Moreira, Alan, and Tyler Muir (2017). "Volatility-Managed Portfolios." _The Journal of Finance_ 72(4).
- Moskowitz, Tobias J., Yao Hua Ooi, and Lasse Heje Pedersen (2012). "Time Series Momentum." _Journal of Financial Economics_ 104(2).
- Sullivan, Ryan, Allan Timmermann, and Halbert White (1999). "Data-Snooping, Technical Trading Rule Performance, and the Bootstrap." _The Journal of Finance_ 54(5).

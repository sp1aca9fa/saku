# 03. Assets

The asset universe is an admin choice. Each tier needs its own data gate before its tickers are usable in strategies. A user-added ticker is usable only after passing the data quality checks (04) over its full history. The UI states each asset's history length and which crisis periods it covers. The tiers below are the default universe (US-listed ETFs, which the strategy library is built on).

| Tier | Assets | When | Notes |
|---|---|---|---|
| 0 (core) | SPY, SSO, UPRO, SPXL, QQQ, QLD, TQQQ, IEF, TLT, GLD. Cash (USD and the base currency, see 05). | Stage A | SPY-centric. Thin slice (A2) uses SPY, SSO, UPRO and cash. Note short histories: IEF/TLT from 2002, GLD 2004, UPRO 2009 (earlier periods use synthetic leverage). |
| 1 | VT, VTI, IWM, EFA, VWO, SHY, AGG, TIP, VNQ, DBC, sector ETFs | C2 | Benchmarks and diversification; alternatives via ETF proxies. VT only from 2008. |
| 2 | Signal inputs, never tradable: FRED `BAMLH0A0HYM2`, `T10Y2Y`, `NFCI`, `UNRATE`, `VIXCLS`, `SP500` | F2 | Regime filters. |
| 3 | Large-cap US stocks | Later | Survivorship caveats. |
| 4 (optional) | Local-market ETFs and mutual fund NAVs (e.g. Japanese funds such as eMAXIS, through a plug-in) | Later | Until a source exists, labeled US ETF proxies. |
| 5 (optional) | Crypto | Later | 24/7 calendar. |

No intraday data. Revisit only if auto-execution is ever added.


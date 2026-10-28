# Data spike (Stage A1)

Findings on each source's limits, API and terms, checked 2026-10-27 from the providers' public pages. Each row says where a point still needs a real run on the server or the owner's reading. Measurements from the 20-day run go in the sections at the end.

## Sources

| Source | Plug-in | Free plan limits (as published) | API (daily data) | Key |
|---|---|---|---|---|
| Tiingo | public | 500 unique symbols/month, 50 requests/hour, 1,000/day, 1 GB/month; 30+ years of prices | `GET api.tiingo.com/tiingo/daily/<ticker>/prices?startDate&endDate`: `date, open, high, low, close, volume, adjOpen, adjHigh, adjLow, adjClose, adjVolume, divCash, splitFactor` (raw and adjusted). Metadata `GET /tiingo/daily/<ticker>`: `ticker, name, exchangeCode, startDate, endDate` | `TIINGO_API_KEY`, sent as `Authorization: Token <key>` |
| Alpaca | public | 200 historical calls/min; history from 2016; the latest 15 minutes excluded without a paid plan | `GET data.alpaca.markets/v2/stocks/bars?symbols&timeframe=1Day&start&end&adjustment=raw&feed=sip`: `t, o, h, l, c, v, n, vw`, paged by `next_page_token`. Dividends and splits: `GET /v1/corporate-actions?symbols&types=cash_dividend,forward_split,reverse_split&start&end` (`ex_date, rate`; `old_rate, new_rate`) | `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY` headers |
| Massive (formerly Polygon) | public | 5 calls/min; 2 years; end of day | Grouped daily: `GET /v2/aggs/grouped/locale/us/market/stocks/{date}?adjusted=false` (all US tickers for one date in one call: `T, o, h, l, c, v, vw, t, n`); on every stocks plan including Basic. Dividends and splits through the reference endpoints ("Corporate Actions" is listed on Basic) | `MASSIVE_API_KEY` |
| Yahoo (`yahoo-finance2`) | private | Unofficial; no published limits | Its close is split-adjusted; dividends and splits as events | none |
| FRED | public | Not stated in the terms; libraries report 120 requests/min per key | `GET api.stlouisfed.org/fred/series/observations?series_id&observation_start&observation_end&file_type=json`: `date, value` (text), with `realtime_start` (the vintage date) | `FRED_API_KEY` (in the URL; redacted in logs) |
| ECB | public | None stated | SDMX data API, series `EXR/D.USD.EUR.SP00.A` and `EXR/D.JPY.EUR.SP00.A`; published around 16:00 CET on TARGET working days | none |

### Points still to check on a real run
- Alpaca: whether the free plan returns `feed=sip` daily bars (older docs say paper-only accounts get IEX only; IEX volume is a fraction of the consolidated volume and its OHLC can differ). Corporate actions coverage back to 2016.
- Alpaca: older Alpaca pages say a paper-only account is open to anyone worldwide (email only). The owner confirms when signing up from Japan.
- Massive: the dividends and splits endpoints on the Basic plan; history for the grouped daily call (2 years means at most about 500 calls to fill, about 2 hours at 4 calls/min).
- FRED: the actual rate limit (a 429 stops the source for the run; the client paces at 80% of 120/min).
- Data finalization times (below).

## Terms

| Source | Personal use | Sharing with other accounts | AI use | `noAi` (until the owner decides) |
|---|---|---|---|---|
| Tiingo | Starter is "Internal Use Only": "you may only use the data for your own personal use and you may not display or share" | **Not allowed as worded** (see below) | The terms page refuses automated access; the owner reads it | `true` |
| Alpaca | Market data under the exchanges' subscriber agreements (NASDAQ, NYSE), linked from alpaca.markets/disclosures | To read: exchange agreements usually limit non-professional data to the subscriber's own use | Not mentioned on the pages read | `true` until the agreements are read |
| Massive | Individuals terms: "solely for your own personal, non-commercial, and non-business purposes"; no sharing of the account or keys | Not addressed directly; copying is limited | Not mentioned | `true` until the Market Data Terms are read |
| Yahoo | Unofficial | Unclear | Unclear | `true` (private plug-in) |
| FRED | Free; show "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis."; for apps used by others, link the terms | Allowed for public-domain series. Copyrighted series (the notes say "Copyright", e.g. `SP500` from S&P Dow Jones Indices) are personal use only | Not mentioned | `false` (SP500: see below) |
| ECB | Free reuse; cite the ECB as the source; state any modification (a USD/JPY cross derived from two euro rates is one) | Allowed with the citation | Not mentioned | `false` |

### Owner decisions
1. **Family accounts and "personal use" terms.** Decided 2026-10-27: the owner's install has a single user, which is personal use; revisit before adding another account (family, demo with real data, usability test). Background: Tiingo's free plan, and probably Alpaca's and Massive's, allow use by the key holder only. Other accounts on the owner's install seeing prices, charts or signals built from them may count as display or sharing. Options:
   - each person brings their own key (the install keeps per-source data per key holder, which goes against shared market data);
   - other accounts see only signals and health, no prices from those sources (whether derived signals count as display is unclear);
   - a paid plan that allows it (Tiingo Power or other), only with the owner's approval;
   - ask Tiingo support in writing.
2. **AI use (`noAi`).** Matters from E1 (MCP), when the flags are revisited. None of the pages read mention AI. Until the owner reads Tiingo's terms and the exchange agreements, Tiingo, Alpaca, Massive and Yahoo stay `noAi: true`: their raw values never reach the MCP server or AI exports (derived results and health still do).
3. **FRED `SP500`** is S&P copyrighted and personal use only. It is a check (layer C), so its values never need to be shown to other accounts or given to AI; the plug-in marks it `noAi` per series.

## Data finalization times
To be measured on the server. Tiingo says most US end-of-day prices are ready around 17:30 New York time, with exchange corrections until 20:00, which it applies through the evening. That is 07:30-10:00 JST in winter (06:30-09:00 in summer).

## Issuer data (best effort)
To record per Tier 0 ETF: issuer, whether daily NAV, distributions and splits are published in a machine-readable form, and the URL.

Found on the issuers' fund pages (2026-10-29); whether each file answers a server, and what it holds, is checked by a probe run on the server (private, by hand; results below when run). Issuer files are published downloads, not APIs: any `IssuerSource` built on them (A3) goes in the private plug-ins.

| ETF | Issuer | NAV history | Distributions | Notes |
|---|---|---|---|---|
| SPY | State Street (SPDR) | xlsx per fund (`navhist-us-en-<ticker>.xlsx`) | Web page and a yearly schedule (PDF); tax summaries (xlsx) | |
| GLD | World Gold Trust (SPDR) | Historical archive (xlsx) on the trust's site; also the SPDR NAV file | None (pays no distributions) | NAV from the LBMA Gold Price PM |
| SSO, UPRO, QLD, TQQQ | ProShares | CSV per fund (`<ticker>-historical_nav.csv`) | Web table | |
| IEF, TLT | iShares | "Data Download" spreadsheet per fund (contents to confirm) | In the same file if it keeps its former layout | |
| SPXL | Direxion | No file link found; the site refuses automated reads | Web table | |
| QQQ | Invesco | No file link found on the fund page | Web table | |

## RFC 3161 timestamp authorities
To choose in A2 (terms, availability).

## 20-day run
Per day and source: data received (any run that day), failures and their reasons. Filled from the server's job runs.

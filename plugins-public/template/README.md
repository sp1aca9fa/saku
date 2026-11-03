# Template plug-in

Example Market Data: a made-up bar provider, to copy when writing a plug-in for a real one. It is
not loaded by the jobs (only `src/index.ts` of `plugins-public/` and `private/` are).

- `src/example-bars.ts`: the `BarSource` (daily bars and ticker metadata)
- `src/index.ts`: a package entry point, one array per kind (`bars`, `taxFx`, `taxRegimes`)
- `fixtures/`: the provider's answers, saved as files (synthetic here; real ones only in the
  private repo)
- `test/example-bars.test.ts`: the test, run by `pnpm test`

A second plug-in for the same provider (its FX, say) sets the same `info.provider` and
`info.limits` as the first, so their requests share the provider's limits; see `docs/plugins.md`.

An issuer source (`IssuerSource`) also declares what its records hold in `info.publishes`
(`{ nav: true }` for a NAV-only file); see `docs/plugins.md`.

Examplia: a made-up country's tax regime (`TaxRegime`), to copy when writing one for a real
country (see "Writing a tax regime" in `docs/plugins.md`).

- `src/example-tax-regime.ts`: the declaration (a taxable account and a tax-free account with an
  annual limit)
- `messages/examplia/`: its texts in English and Japanese
- `fixtures/examplia-faults.json`: faults injected one at a time, each of which must be refused
- `test/example-tax-regime.test.ts`: the test

Example Bank of Examplia: a made-up bank's daily rates for tax (`TaxFxSource`), mapped onto
Examplia's rate names (MID, ASK, BID), to copy when writing one for a real bank (see "Tax FX
sources" in `docs/plugins.md`).

- `src/example-tax-fx.ts`: the source (no key; the answer's shape checked, values left to core)
- `fixtures/rates-usdxts.json`: the bank's answer (one day without an ask: left out, never 0)
- `fixtures/examplia-tax-fx-faults.json`: faults injected one at a time (a rate of 0 or below,
  buy below mid, mid below sell, a missing or impossible date, another pair), each refused
- `test/example-tax-fx.test.ts`: the test

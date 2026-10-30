# Template plug-in

Example Market Data: a made-up bar provider, to copy when writing a plug-in for a real one. It is
not loaded by the jobs (only `src/index.ts` of `plugins-public/` and `plugins/` are).

- `src/example-bars.ts`: the `BarSource` (daily bars and ticker metadata)
- `src/index.ts`: a package entry point, one array per kind
- `fixtures/`: the provider's answers, saved as files (synthetic here; real ones only in the
  private repo)
- `test/example-bars.test.ts`: the test, run by `pnpm test`

A second plug-in for the same provider (its FX, say) sets the same `info.provider` and
`info.limits` as the first, so their requests share the provider's limits; see `docs/plugins.md`.

An issuer source (`IssuerSource`) also declares what its records hold in `info.publishes`
(`{ nav: true }` for a NAV-only file); see `docs/plugins.md`.

A tax regime template follows in Stage C1.

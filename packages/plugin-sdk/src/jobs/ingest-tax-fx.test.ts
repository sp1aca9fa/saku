// Tax FX ingest (requirements 07 "FX for tax", 15 `TaxFxSource`): fetched only under the
// install's regime, checked whole, stored per kind apart from valuation rates; fault cases.
import { fxPointInTime, schema } from '@saku/db';
import { testDb } from '@saku/db/testing';
import { Sessions } from '@saku/data';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { emptyPlugins } from '../registry';
import { setTaxRegime } from '../tax-regime';
import type { PluginInfo, TaxFxRate, TaxFxSource, TaxRegime } from '../types';
import { countsForRun, ingest } from './ingest';

const sessions = new Sessions({
  id: 'test',
  version: 't',
  validFrom: '1990-01-01',
  validTo: '2026-12-31',
  holidays: [],
});

/** Only what ingest and setting the regime read (its key, currency, account types, rate names). */
const regime = {
  info: {
    key: 'examplia',
    kind: 'tax_regime',
    version: '1',
    nameKey: 'n',
    country: 'QX',
    currency: 'XTS',
    sources: ['https://tax.example.test'],
  },
  accountTypes: [{ key: 'taxable' }],
  fx: {
    rates: {
      MID: { kind: 'tax_mid', nameKey: 'm' },
      ASK: { kind: 'tax_buy', nameKey: 'b' },
      BID: { kind: 'tax_sell', nameKey: 's' },
    },
    purchases: 'ASK',
    sales: 'BID',
    dividends: 'MID',
  },
} as unknown as TaxRegime;

const day = (date: string, mid: number, buy: number, sell: number): TaxFxRate[] => [
  { pair: 'USDXTS', date, rate: mid, kind: 'tax_mid', name: 'MID' },
  { pair: 'USDXTS', date, rate: buy, kind: 'tax_buy', name: 'ASK' },
  { pair: 'USDXTS', date, rate: sell, kind: 'tax_sell', name: 'BID' },
];

function source(answer: () => TaxFxRate[]): TaxFxSource & { asked: string[] } {
  const asked: string[] = [];
  const info: PluginInfo = {
    key: 'example-bank',
    kind: 'tax_fx',
    name: 'Example Bank',
    provides: { pairs: ['USDXTS'] },
    suggestedRole: 'primary',
    termsUrl: 'https://bank.example.test/terms',
  };
  return {
    info,
    asked,
    supports: (pair) => pair === 'USDXTS',
    async fetchRates(pair) {
      asked.push(pair);
      return answer();
    },
  };
}

const warnings: string[] = [];
const log = { info: () => {}, warn: (m: string) => void warnings.push(m) };
const options = {
  mode: 'daily' as const,
  to: '2026-01-16',
  sessions,
  runId: null,
  log,
  context: () => ({ http: undefined as never, now: new Date(), log }),
  now: () => new Date('2026-01-17T01:00:00Z'),
};

async function setup(set = true) {
  const db = await testDb();
  if (set) await setTaxRegime(db, 'examplia', [regime]);
  return db;
}
const run = (db: Awaited<ReturnType<typeof setup>>, s: TaxFxSource, now = options.now) =>
  ingest(db, { ...emptyPlugins(), taxFx: [s], taxRegimes: [regime] }, { ...options, now });

describe('ingest: tax FX', () => {
  it('stores each kind under its own kind, never as a valuation rate', async () => {
    const db = await setup();
    const s = source(() => [
      ...day('2026-01-15', 150, 151, 149),
      ...day('2026-01-16', 152, 153, 151),
    ]);
    const [r] = await run(db, s);
    expect(s.asked).toEqual(['USDXTS']);
    expect(r).toMatchObject({ kind: 'tax_fx', ok: ['USDXTS'], failed: [], inserted: 6 });
    const read = async (kind: 'tax_mid' | 'tax_buy' | 'tax_sell' | 'valuation') =>
      (await fxPointInTime(db, 'USDXTS', 'example-bank', kind)).asOf(
        '2026-01-16',
        '2026-01-18T00:00:00Z',
      )?.value;
    expect(await read('tax_mid')).toBe(152);
    expect(await read('tax_buy')).toBe(153);
    expect(await read('tax_sell')).toBe(151);
    expect(await read('valuation')).toBeUndefined();
  });

  it('a changed rate is a new vintage, reported per pair and kind', async () => {
    const db = await setup();
    await run(
      db,
      source(() => day('2026-01-16', 150, 151, 149)),
    );
    const later = () => new Date('2026-01-18T01:00:00Z');
    const [r] = await run(
      db,
      source(() => day('2026-01-16', 150, 151.5, 149)),
      later,
    );
    expect(r!.revisedValues).toEqual({ 'USDXTS tax_buy': ['2026-01-16'] });
    expect((await db.select().from(schema.fxRates)).length).toBe(4);
  });

  for (const [fault, rates] of [
    ['a rate of 0', [...day('2026-01-15', 150, 151, 149), ...day('2026-01-16', 0, 151, 149)]],
    ['buy below mid', [...day('2026-01-15', 150, 151, 149), ...day('2026-01-16', 152, 151, 149)]],
    [
      'a rate without its date',
      [...day('2026-01-15', 150, 151, 149), { ...day('2026-01-16', 1, 1, 1)[0]!, date: undefined }],
    ],
    [
      'a rate under the wrong name',
      [
        ...day('2026-01-15', 150, 151, 149),
        { ...day('2026-01-16', 152, 153, 151)[0]!, name: 'BID' },
      ],
    ],
  ] as [string, TaxFxRate[]][]) {
    it(`fault: ${fault} refuses the whole response, nothing stored`, async () => {
      const db = await setup();
      const [r] = await run(
        db,
        source(() => rates),
      );
      expect(r!.ok).toEqual([]);
      expect(r!.failed).toEqual([
        { item: 'USDXTS', error: expect.stringMatching(/^tax rates refused, nothing stored: /) },
      ]);
      expect(await db.select().from(schema.fxRates)).toEqual([]);
    });
  }

  it('fetches nothing without a usable install regime, and says why', async () => {
    warnings.length = 0;
    const s = source(() => day('2026-01-16', 150, 151, 149));
    // Not set.
    const db = await setup(false);
    expect(await run(db, s)).toEqual([]);
    // Set, then the loaded declaration changed (a rule edited by a plug-in update): the source
    // with a role is reported stopped, so the run is incomplete (no heartbeat).
    const db2 = await setup();
    const changed = { ...regime, info: { ...regime.info, version: '2' } } as TaxRegime;
    const stopped = (why: string) => [
      expect.objectContaining({
        source: 'example-bank',
        kind: 'tax_fx',
        ok: [],
        stopped: `no tax FX fetched: ${why}`,
      }),
    ];
    const reports = await ingest(
      db2,
      { ...emptyPlugins(), taxFx: [s], taxRegimes: [changed] },
      options,
    );
    expect(reports).toEqual(stopped("the examplia regime's rules changed since it was set"));
    expect(reports.filter(countsForRun)).toHaveLength(1);
    // Set, then no loaded regime has the key.
    expect(await ingest(db2, { ...emptyPlugins(), taxFx: [s] }, options)).toEqual(
      stopped('no loaded tax regime has the key examplia'),
    );
    expect(s.asked).toEqual([]);
    expect(warnings.filter((w) => w.startsWith('No tax FX'))).toEqual([
      'No tax FX fetched: tax_regime is not set',
      "No tax FX fetched: the examplia regime's rules changed since it was set",
      'No tax FX fetched: no loaded tax regime has the key examplia',
    ]);
    expect(await db2.select().from(schema.fxRates)).toEqual([]);
  });

  it('fault: a partial revision (only the TTS republished, below the stored TTM) stores nothing', async () => {
    const db = await setup();
    const t1 = '2026-01-16T01:00:00Z';
    const stamped = (r: TaxFxRate) => ({ ...r, publishedAt: t1 });
    await run(
      db,
      source(() => day('2026-01-16', 150, 151, 149).map(stamped)),
    );
    const later = () => new Date('2026-01-18T01:00:00Z');
    const tts = { ...day('2026-01-16', 0, 149.5, 0)[1]!, publishedAt: '2026-01-17T01:00:00Z' };
    const [r] = await run(
      db,
      source(() => [tts]),
      later,
    );
    expect(r!.failed).toEqual([
      {
        item: 'USDXTS',
        error:
          'tax rates refused, nothing stored: tax rates out of order as they would be read: ' +
          'USDXTS 2026-01-16: tax_buy 149.5 is below tax_mid 150',
      },
    ]);
    expect(await db.select().from(schema.fxRates)).toHaveLength(3);
    // A later TTS still above the stored TTM is stored.
    const [ok] = await run(
      db,
      source(() => [{ ...tts, rate: 151.5 } as TaxFxRate]),
      later,
    );
    expect(ok).toMatchObject({ ok: ['USDXTS'], inserted: 1 });
  });

  it('fault: a missing stamp is known at the fetch and ordered against the stored rates', async () => {
    const db = await setup();
    const t1 = '2026-01-16T01:00:00Z';
    await run(
      db,
      source(() => day('2026-01-16', 150, 151, 149).map((r) => ({ ...r, publishedAt: t1 }))),
    );
    const later = () => new Date('2026-01-18T01:00:00Z');
    const unstamped = day('2026-01-16', 0, 0, 150.5)[2]!;
    const [r] = await run(
      db,
      source(() => [unstamped]),
      later,
    );
    expect(r!.failed[0]!.error).toMatch(/tax_mid 150 is below tax_sell 150.5/);
    expect(await db.select().from(schema.fxRates)).toHaveLength(3);
  });

  it('fault: the last write failing at store time stores nothing of the other kinds', async () => {
    const db = await setup();
    // Values of all three kinds go in first; the tax_buy withdrawal is the last statement of the
    // transaction, and fails (a storage error).
    await db.run(
      sql.raw(`CREATE TRIGGER test_fail_last BEFORE INSERT ON fx_withdrawals WHEN NEW.kind = 'tax_buy'
        BEGIN SELECT RAISE(ABORT, 'disk full (test)'); END`),
    );
    const withdrawn: TaxFxRate = {
      pair: 'USDXTS',
      date: '2026-01-16',
      withdrawn: true,
      kind: 'tax_buy',
      name: 'ASK',
    };
    const [r] = await run(
      db,
      source(() => [...day('2026-01-15', 150, 151, 149), withdrawn]),
    );
    expect(r!.failed[0]!.error).toMatch(
      /^tax rates refused, nothing stored: Failed query: insert into "fx_withdrawals"/,
    );
    expect(await db.select().from(schema.fxRates)).toEqual([]);
    expect(await db.select().from(schema.fxWithdrawals)).toEqual([]);
  });

  it('asks nothing of a source that does not support the pair', async () => {
    const db = await setup();
    const s = { ...source(() => []), supports: () => false };
    const [r] = await run(db, s);
    expect(r).toMatchObject({ ok: [], failed: [] });
  });
});

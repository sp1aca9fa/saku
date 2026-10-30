import { zonedInstant } from '@saku/core';
import { fixtureContext } from '@saku/plugin-sdk/testing';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ECB_MAX_DAYS, ecb, ecbChunks } from '../src/ecb';
import { FRED_VINTAGES_PER_WINDOW, fredFx, fredSeries } from '../src/fred';
import { fixture } from './fixture';

/** Routes FRED's two endpoints: vintage dates from a fixture, observations from another. */
function fredRoutes(
  observations: (url: URL) => unknown,
  vintages: unknown = fixture('fred-vintagedates.json'),
) {
  return (url: URL) =>
    url.pathname.endsWith('/vintagedates')
      ? typeof vintages === 'function'
        ? (vintages as (u: URL) => unknown)(url)
        : vintages
      : observations(url);
}

const DAY_MS = 86_400_000;
const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const at18NY = (date: string) => zonedInstant(date, '18:00', 'America/New_York');

/** A vintagedates answer in FRED's shape. */
function vintagePage(dates: string[], count = dates.length, offset = 0) {
  return {
    realtime_start: '1776-07-04',
    realtime_end: '9999-12-31',
    order_by: 'vintage_date',
    sort_order: 'asc',
    count,
    offset,
    limit: 10000,
    vintage_dates: dates,
  };
}

/** An observations answer in FRED's shape. */
function observationPage(
  rows: { realtime_start: string; realtime_end: string; date: string; value: string }[],
  url: URL,
) {
  return {
    realtime_start: url.searchParams.get('realtime_start'),
    realtime_end: url.searchParams.get('realtime_end'),
    observation_start: url.searchParams.get('observation_start'),
    observation_end: url.searchParams.get('observation_end'),
    units: 'lin',
    output_type: 1,
    file_type: 'json',
    order_by: 'observation_date',
    sort_order: 'asc',
    count: rows.length,
    offset: 0,
    limit: 100000,
    observations: rows,
  };
}

describe('FRED', () => {
  it('keeps every vintage and leaves out missing values', async () => {
    const ctx = fixtureContext(
      fredRoutes(() => fixture('fred-dtb3.json')),
      { apiKey: 'abc' },
    );
    expect(await fredSeries.fetchSeries('DTB3', '2026-01-01', '2026-01-06', ctx)).toEqual([
      // The vintage day at 18:00 New York (EST: 23:00 UTC), never its midnight.
      { date: '2026-01-02', value: 3.61, publishedAt: '2026-01-05T23:00:00.000Z' },
      { date: '2026-01-02', value: 3.62, publishedAt: '2026-01-07T23:00:00.000Z' },
      { date: '2026-01-05', value: 3.6, publishedAt: '2026-01-06T23:00:00.000Z' },
    ]);
    // Few vintages: the vintage list, then the single full-axis request as before.
    expect(ctx.requested).toHaveLength(2);
    const vintages = new URL(ctx.requested[0]!);
    expect(vintages.pathname).toBe('/fred/series/vintagedates');
    expect(vintages.searchParams.get('series_id')).toBe('DTB3');
    const url = new URL(ctx.requested[1]!);
    expect(url.pathname).toBe('/fred/series/observations');
    expect(url.searchParams.get('series_id')).toBe('DTB3');
    expect(url.searchParams.get('realtime_start')).toBe('1776-07-04');
    expect(url.searchParams.get('realtime_end')).toBe('9999-12-31');
  });

  it('maps FX pairs to H.10 series', async () => {
    const ctx = fixtureContext(
      fredRoutes(() => fixture('fred-dtb3.json')),
      { apiKey: 'abc' },
    );
    const rates = await fredFx.fetchRates('USDJPY', '2026-01-01', '2026-01-06', ctx);
    expect(new URL(ctx.requested[1]!).searchParams.get('series_id')).toBe('DEXJPUS');
    expect(rates[0]).toEqual({
      pair: 'USDJPY',
      date: '2026-01-02',
      rate: 3.61,
      publishedAt: '2026-01-05T23:00:00.000Z',
    });
    await expect(fredFx.fetchRates('USDXXX', '2026-01-01', '2026-01-06', ctx)).rejects.toThrow();
  });

  describe('many vintages: real-time windows', () => {
    // 2500 vintages, one per day: windows of 1000 vintages, so three windows.
    const v = Array.from({ length: 2500 }, (_, i) => addDays('2010-01-01', i));
    const w1 = v[FRED_VINTAGES_PER_WINDOW]!;
    const w2 = v[2 * FRED_VINTAGES_PER_WINDOW]!;
    const end0 = addDays(w1, -1);
    const end1 = addDays(w2, -1);
    const row = (date: string, value: string, start: string, end: string) => ({
      realtime_start: start,
      realtime_end: end,
      date,
      value,
    });
    // What FRED answers per window: each period clipped to the window.
    const answers: Record<string, ReturnType<typeof row>[]> = {
      '1776-07-04': [
        // A: published once, never revised.
        row('2009-12-01', '1.00', v[0]!, end0),
        // B: revised exactly on the second window's first vintage.
        row('2009-12-02', '2.00', v[5]!, end0),
        // C: revised inside the second window.
        row('2009-12-03', '3.00', v[10]!, end0),
        // D: a value, then missing, then the same value again from the second window on.
        row('2009-12-04', '4.00', v[20]!, v[29]!),
        row('2009-12-04', '.', v[30]!, end0),
      ],
      [w1]: [
        row('2009-12-01', '1.00', w1, end1),
        row('2009-12-02', '2.50', w1, end1),
        row('2009-12-03', '3.00', w1, addDays(v[1500]!, -1)),
        row('2009-12-03', '3.10', v[1500]!, end1),
        row('2009-12-04', '4.00', w1, end1),
      ],
      [w2]: [
        row('2009-12-01', '1.00', w2, '9999-12-31'),
        row('2009-12-02', '2.50', w2, '9999-12-31'),
        row('2009-12-03', '3.10', w2, '9999-12-31'),
        row('2009-12-04', '4.00', w2, '9999-12-31'),
      ],
    };
    const context = (overrides: Record<string, ReturnType<typeof row>[]> = {}) =>
      fixtureContext(
        fredRoutes((url) => {
          const start = url.searchParams.get('realtime_start')!;
          return observationPage(overrides[start] ?? answers[start] ?? [], url);
        }, vintagePage(v)),
        { apiKey: 'abc' },
      );

    it('splits the real-time axis into windows without gaps or overlap', async () => {
      const ctx = context();
      await fredSeries.fetchSeries('DTB3', '2009-12-01', '2009-12-04', ctx);
      const windows = ctx.requested
        .map((u) => new URL(u))
        .filter((u) => u.pathname.endsWith('/observations'))
        .map((u) => [u.searchParams.get('realtime_start'), u.searchParams.get('realtime_end')]);
      expect(windows).toEqual([
        ['1776-07-04', end0],
        [w1, end1],
        [w2, '9999-12-31'],
      ]);
    });

    const expected = [
      // A continues through both boundaries: one vintage, the first.
      { date: '2009-12-01', value: 1, publishedAt: at18NY(v[0]!) },
      // B changed on the boundary vintage itself: a real new vintage there.
      { date: '2009-12-02', value: 2, publishedAt: at18NY(v[5]!) },
      { date: '2009-12-02', value: 2.5, publishedAt: at18NY(w1) },
      // C: the continuation at the boundary is dropped; the revision inside is kept.
      { date: '2009-12-03', value: 3, publishedAt: at18NY(v[10]!) },
      { date: '2009-12-03', value: 3.1, publishedAt: at18NY(v[1500]!) },
      // D: missing at the boundary, so the same value coming back there is a new vintage.
      { date: '2009-12-04', value: 4, publishedAt: at18NY(v[20]!) },
      { date: '2009-12-04', withdrawn: true, publishedAt: at18NY(v[30]!) },
      { date: '2009-12-04', value: 4, publishedAt: at18NY(w1) },
    ];

    it('keeps each value at its first vintage; a change at or inside a window is a new one', async () => {
      const points = await fredSeries.fetchSeries('DTB3', '2009-12-01', '2009-12-04', context());
      expect(points).toEqual(expected);
    });

    it('gives the same points when the periods come back unclipped', async () => {
      // The true real-time periods; each window answers those that overlap it, unclipped.
      const truth = [
        row('2009-12-01', '1.00', v[0]!, '9999-12-31'),
        row('2009-12-02', '2.00', v[5]!, end0),
        row('2009-12-02', '2.50', w1, '9999-12-31'),
        row('2009-12-03', '3.00', v[10]!, addDays(v[1500]!, -1)),
        row('2009-12-03', '3.10', v[1500]!, '9999-12-31'),
        row('2009-12-04', '4.00', v[20]!, v[29]!),
        row('2009-12-04', '.', v[30]!, end0),
        row('2009-12-04', '4.00', w1, '9999-12-31'),
      ];
      const windows: [string, string][] = [
        ['1776-07-04', end0],
        [w1, end1],
        [w2, '9999-12-31'],
      ];
      const unclipped = Object.fromEntries(
        windows.map(([a, b]) => [
          a,
          truth.filter((r) => r.realtime_start <= b && r.realtime_end >= a),
        ]),
      );
      // w1 does answer rows that start before it and end after it.
      expect(unclipped[w1]!.some((r) => r.realtime_start < w1 && r.realtime_end > end1)).toBe(true);
      const points = await fredSeries.fetchSeries(
        'DTB3',
        '2009-12-01',
        '2009-12-04',
        context(unclipped),
      );
      expect(points).toEqual(expected);
    });

    it('refuses a row outside its own window', async () => {
      // Starts after the first window's end.
      const late = context({ '1776-07-04': [row('2009-12-01', '1.00', w1, end1)] });
      await expect(
        fredSeries.fetchSeries('DTB3', '2009-12-01', '2009-12-04', late),
      ).rejects.toThrow(/outside its real-time window/);
      // Ends before the second window starts.
      const early = context({ [w1]: [row('2009-12-01', '1.00', v[0]!, v[3]!)] });
      await expect(
        fredSeries.fetchSeries('DTB3', '2009-12-01', '2009-12-04', early),
      ).rejects.toThrow(/outside its real-time window/);
    });

    it('refuses a row that claims to start in an earlier window the earlier window did not show', async () => {
      const ctx = context({ [w2]: [row('2009-12-05', '5.00', v[100]!, '9999-12-31')] });
      await expect(fredSeries.fetchSeries('DTB3', '2009-12-01', '2009-12-05', ctx)).rejects.toThrow(
        /starts before its real-time window/,
      );
    });
  });

  it('pages the vintage dates and checks they are complete', async () => {
    const v = Array.from({ length: 10_001 }, (_, i) => addDays('1990-01-01', i));
    const pages = (url: URL) => {
      const offset = Number(url.searchParams.get('offset'));
      return vintagePage(v.slice(offset, offset + 10_000), v.length, offset);
    };
    const ctx = fixtureContext(
      fredRoutes((url) => observationPage([], url), pages),
      { apiKey: 'abc' },
    );
    expect(await fredSeries.fetchSeries('DTB3', '2026-01-01', '2026-01-06', ctx)).toEqual([]);
    const urls = ctx.requested.map((u) => new URL(u));
    const vintageOffsets = urls
      .filter((u) => u.pathname.endsWith('/vintagedates'))
      .map((u) => u.searchParams.get('offset'));
    expect(vintageOffsets).toEqual(['0', '10000']);
    // 10,001 vintages in windows of 1000: 11 observation requests.
    expect(urls.filter((u) => u.pathname.endsWith('/observations'))).toHaveLength(11);

    // A list shorter than announced, or out of order, is refused.
    const short = fixtureContext(
      fredRoutes(
        (url) => observationPage([], url),
        (url: URL) =>
          url.searchParams.get('offset') === '0'
            ? vintagePage(v.slice(0, 10_000), v.length, 0)
            : vintagePage([], v.length, 10_000),
      ),
      { apiKey: 'abc' },
    );
    await expect(fredSeries.fetchSeries('DTB3', '2026-01-01', '2026-01-06', short)).rejects.toThrow(
      /10000 vintage dates read, 10001 announced/,
    );
    const unordered = fixtureContext(
      fredRoutes((url) => observationPage([], url), vintagePage(['2026-01-06', '2026-01-05'])),
      { apiKey: 'abc' },
    );
    await expect(
      fredSeries.fetchSeries('DTB3', '2026-01-01', '2026-01-06', unordered),
    ).rejects.toThrow(/unordered vintage date/);
  });

  it('refuses a vintage page at the wrong offset or an empty page before the end', async () => {
    const v = Array.from({ length: 20_001 }, (_, i) => addDays('1950-01-01', i));
    const shifted = fixtureContext(
      fredRoutes((url) => observationPage([], url), vintagePage(v.slice(0, 10_000), v.length, 5)),
      { apiKey: 'abc' },
    );
    await expect(
      fredSeries.fetchSeries('DTB3', '2026-01-01', '2026-01-06', shifted),
    ).rejects.toThrow(/vintage page at the wrong offset/);
    const hole = fixtureContext(
      fredRoutes(
        (url) => observationPage([], url),
        (url: URL) => {
          const offset = Number(url.searchParams.get('offset'));
          const dates = offset === 10_000 ? [] : v.slice(offset, offset + 10_000);
          return vintagePage(dates, v.length, offset);
        },
      ),
      { apiKey: 'abc' },
    );
    await expect(fredSeries.fetchSeries('DTB3', '2026-01-01', '2026-01-06', hole)).rejects.toThrow(
      /empty vintage page/,
    );
  });

  it('refuses a real-time period that ends before it starts', async () => {
    const ctx = fixtureContext(
      fredRoutes((url) =>
        observationPage(
          [
            {
              realtime_start: '2026-01-07',
              realtime_end: '2026-01-06',
              date: '2026-01-02',
              value: '3.61',
            },
          ],
          url,
        ),
      ),
      { apiKey: 'abc' },
    );
    await expect(fredSeries.fetchSeries('DTB3', '2026-01-01', '2026-01-06', ctx)).rejects.toThrow(
      /ends before it starts/,
    );
  });

  describe('a series without vintages in ALFRED (SP500)', () => {
    const refused = () =>
      new Response(JSON.stringify(fixture('fred-not-in-alfred.json')), {
        status: 400,
      });

    it('fetches the current values, with no publication time claimed', async () => {
      const ctx = fixtureContext(
        fredRoutes(() => fixture('fred-sp500-current.json'), refused),
        { apiKey: 'abc' },
      );
      const points = await fredSeries.fetchSeries('SP500', '2026-01-01', '2026-01-06', ctx);
      // FRED's real-time period is the fetch day for every row: not a publication time, so no
      // publishedAt (stored as known from the fetch, never earlier); '.' left out.
      expect(points).toEqual([
        { date: '2026-01-02', value: 5001.25 },
        { date: '2026-01-05', value: 5010.5 },
        { date: '2026-01-06', value: 4998 },
      ]);
      expect(points.every((p) => !('publishedAt' in p))).toBe(true);
      expect(ctx.requested).toHaveLength(2);
      const url = new URL(ctx.requested[1]!);
      expect(url.pathname).toBe('/fred/series/observations');
      expect(url.searchParams.get('series_id')).toBe('SP500');
      expect(url.searchParams.get('observation_start')).toBe('2026-01-01');
      expect(url.searchParams.get('observation_end')).toBe('2026-01-06');
      expect(url.searchParams.has('realtime_start')).toBe(false);
      expect(url.searchParams.has('realtime_end')).toBe(false);
    });

    it('gives FX rates without a publication time too', async () => {
      const ctx = fixtureContext(
        fredRoutes(() => fixture('fred-sp500-current.json'), refused),
        { apiKey: 'abc' },
      );
      const rates = await fredFx.fetchRates('USDJPY', '2026-01-01', '2026-01-06', ctx);
      expect(rates[0]).toEqual({ pair: 'USDJPY', date: '2026-01-02', rate: 5001.25 });
    });

    it('still fails on any other 400 from the vintage dates', async () => {
      const other = () => new Response(JSON.stringify(fixture('fred-error.json')), { status: 400 });
      const ctx = fixtureContext(
        fredRoutes(() => fixture('fred-sp500-current.json'), other),
        { apiKey: 'abc' },
      );
      await expect(
        fredSeries.fetchSeries('SP500', '2026-01-01', '2026-01-06', ctx),
      ).rejects.toThrow(/^HTTP 400 for .*vintagedates.*realtime_start is not valid/);
      expect(ctx.requested).toHaveLength(1);
      // The same message with another status is not the ALFRED case either.
      const wrongStatus = fixtureContext(
        fredRoutes(
          () => fixture('fred-sp500-current.json'),
          () => new Response(JSON.stringify(fixture('fred-not-in-alfred.json')), { status: 404 }),
        ),
        { apiKey: 'abc' },
      );
      await expect(
        fredSeries.fetchSeries('SP500', '2026-01-01', '2026-01-06', wrongStatus),
      ).rejects.toThrow(/^HTTP 404/);
    });

    it('refuses a repeated date or a bad value in the current values', async () => {
      const answer = fixture('fred-sp500-current.json') as {
        observations: { date: string; value: string }[];
      };
      const withRows = (rows: { date: string; value: string }[]) =>
        fixtureContext(
          fredRoutes(
            () => ({
              ...answer,
              count: rows.length,
              observations: rows.map((r) => ({
                realtime_start: '2026-01-07',
                realtime_end: '2026-01-07',
                ...r,
              })),
            }),
            refused,
          ),
          { apiKey: 'abc' },
        );
      await expect(
        fredSeries.fetchSeries(
          'SP500',
          '2026-01-01',
          '2026-01-06',
          withRows([
            { date: '2026-01-02', value: '5001.25' },
            { date: '2026-01-02', value: '5002.00' },
          ]),
        ),
      ).rejects.toThrow(/repeated or unordered date/);
      await expect(
        fredSeries.fetchSeries(
          'SP500',
          '2026-01-01',
          '2026-01-06',
          withRows([{ date: '2026-01-02', value: 'n/a' }]),
        ),
      ).rejects.toThrow(/unreadable value/);
    });
  });

  it('says why FRED refused a request, without the key', async () => {
    const key = 'abcd1234efgh';
    const error = fixture('fred-error.json') as { error_message: string };
    const body = { ...error, error_message: `${error.error_message} (api_key ${key})` };
    const ctx = fixtureContext(
      fredRoutes(() => new Response(JSON.stringify(body), { status: 400 })),
      { apiKey: key },
    );
    const message = await fredSeries.fetchSeries('DTB3', '2026-01-01', '2026-01-06', ctx).then(
      () => '',
      (e: Error) => e.message,
    );
    expect(message).toMatch(
      /^HTTP 400 for https:\/\/api\.stlouisfed\.org\/fred\/series\/observations\?.*: Bad Request\. The value for variable realtime_start is not valid for this request\. \(api_key \*\*\*\)$/,
    );
    expect(message).not.toContain(key);
  });
});

describe('ECB', () => {
  const csv = readFileSync(new URL('fixtures/ecb.csv', import.meta.url), 'utf8');

  it('derives a cross from two euro rates, with the publication time', async () => {
    const ctx = fixtureContext(() => csv);
    const rates = await ecb.fetchRates('USDJPY', '2026-01-02', '2026-01-05', ctx);
    expect(ctx.requested).toHaveLength(1);
    expect(ctx.requested[0]).toContain('/EXR/D.USD+JPY.EUR.SP00.A?');
    const url = new URL(ctx.requested[0]!);
    expect(url.searchParams.get('startPeriod')).toBe('2026-01-02');
    // Only the observations: the parser reads CURRENCY, TIME_PERIOD and OBS_VALUE.
    expect(url.searchParams.get('detail')).toBe('dataonly');
    expect(url.searchParams.get('format')).toBe('csvdata');
    expect(url.searchParams.get('endPeriod')).toBe('2026-01-05');
    expect(rates.map((r) => [r.date, r.rate, r.publishedAt])).toEqual([
      ['2026-01-02', 160, '2026-01-02T15:00:00.000Z'],
      ['2026-01-05', 161 / 1.15, '2026-01-05T15:00:00.000Z'],
    ]);
  });

  it('reads euro pairs directly and refuses a half-missing day', async () => {
    const eur = await ecb.fetchRates(
      'EURJPY',
      '2026-01-02',
      '2026-01-05',
      fixtureContext(() => csv),
    );
    expect(eur.map((r) => r.rate)).toEqual([160, 161]);
    const partial = csv
      .split('\n')
      .filter((l) => !l.includes('USD,EUR,SP00,A,2026-01-05'))
      .join('\n');
    await expect(
      ecb.fetchRates(
        'USDJPY',
        '2026-01-02',
        '2026-01-05',
        fixtureContext(() => partial),
      ),
    ).rejects.toThrow(/one currency/);
    const noYen = csv
      .split('\n')
      .filter((l) => !l.includes('JPY,EUR,SP00,A,2026-01-05'))
      .join('\n');
    await expect(
      ecb.fetchRates(
        'USDJPY',
        '2026-01-02',
        '2026-01-05',
        fixtureContext(() => noYen),
      ),
    ).rejects.toThrow(/one currency/);
  });

  it('skips a day with an empty rate and refuses a value that is not a positive number', async () => {
    const header = csv.split('\n')[0]!;
    const rows = (usd: string) =>
      [
        header,
        'EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,1999-12-30,1.0000',
        // Not on the last line, where the answer's trailing whitespace is trimmed.
        `EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,1999-12-31,${usd}`,
        'EXR.D.JPY.EUR.SP00.A,D,JPY,EUR,SP00,A,1999-12-30,100.00',
        'EXR.D.JPY.EUR.SP00.A,D,JPY,EUR,SP00,A,1999-12-31,',
      ].join('\n');
    // Both currencies empty on 1999-12-31: no observation that day, not a rate of 0.
    const rates = await ecb.fetchRates(
      'USDJPY',
      '1999-12-30',
      '1999-12-31',
      fixtureContext(() => rows('')),
    );
    expect(rates.map((r) => [r.date, r.rate])).toEqual([['1999-12-30', 100]]);
    // Only one currency empty: the day is half missing, refused as before.
    await expect(
      ecb.fetchRates(
        'USDJPY',
        '1999-12-30',
        '1999-12-31',
        fixtureContext(() => rows('1.0100')),
      ),
    ).rejects.toThrow(/one currency/);
    for (const bad of ['0', '-1.0', 'NaN', ' ', 'x']) {
      await expect(
        ecb.fetchRates(
          'USDJPY',
          '1999-12-30',
          '1999-12-31',
          fixtureContext(() => rows(bad)),
        ),
      ).rejects.toThrow(/unreadable row/);
    }
    // A row cut before its value column (no cell at all) is refused, not skipped.
    const cut = `${header}\nEXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,1999-12-31`;
    await expect(
      ecb.fetchRates(
        'EURUSD',
        '1999-12-30',
        '1999-12-31',
        fixtureContext(() => cut),
      ),
    ).rejects.toThrow(/unreadable row/);
    // An empty value with an unreadable date is still refused.
    const badDate = `${header}\nEXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,1999-13-31,`;
    await expect(
      ecb.fetchRates(
        'EURUSD',
        '1999-12-30',
        '1999-12-31',
        fixtureContext(() => badDate),
      ),
    ).rejects.toThrow(/unreadable row/);
  });

  describe('long ranges', () => {
    const header = csv.split('\n')[0]!;
    const line = (cur: string, date: string, value: string) =>
      `EXR.D.${cur}.EUR.SP00.A,D,${cur},EUR,SP00,A,${date},${value}`;
    /** Answers each request with rates on its first and last day. */
    const perPart = (url: URL) => {
      const days = [url.searchParams.get('startPeriod')!, url.searchParams.get('endPeriod')!];
      return [
        header,
        ...days.flatMap((d) => [line('JPY', d, '160.00'), line('USD', d, '1.2500')]),
      ].join('\n');
    };

    it('splits a long range into contiguous parts of at most 5 years, from 1999 on', async () => {
      const ctx = fixtureContext(perPart);
      const rates = await ecb.fetchRates('USDJPY', '1990-01-01', '2026-10-28', ctx);
      const parts = ctx.requested.map((u) => {
        const url = new URL(u);
        return [url.searchParams.get('startPeriod')!, url.searchParams.get('endPeriod')!];
      });
      expect(parts.length).toBeGreaterThan(1);
      expect(parts[0]![0]).toBe('1999-01-01');
      expect(parts.at(-1)![1]).toBe('2026-10-28');
      const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
      for (const [k, [from, to]] of parts.entries()) {
        const length = day(to!) - day(from!) + 1;
        expect(length).toBeLessThanOrEqual(ECB_MAX_DAYS);
        expect(length).toBeGreaterThanOrEqual(ECB_MAX_DAYS / 2);
        if (k > 0) expect(day(from!)).toBe(day(parts[k - 1]![1]!) + 1);
      }
      // Same parsed output: one rate per day received, in date order, each the cross.
      expect(rates.map((r) => r.date)).toEqual(parts.flat());
      expect(rates.every((r) => r.rate === 160 / 1.25 && r.pair === 'USDJPY')).toBe(true);
    });

    it('keeps a range of up to 5 years in one request and asks nothing before the euro', async () => {
      expect(ecbChunks('2021-01-01', addDays('2021-01-01', ECB_MAX_DAYS - 1))).toHaveLength(1);
      expect(ecbChunks('2021-01-01', addDays('2021-01-01', ECB_MAX_DAYS))).toHaveLength(2);
      const ctx = fixtureContext(perPart);
      expect(await ecb.fetchRates('USDJPY', '1990-01-01', '1998-12-31', ctx)).toEqual([]);
      expect(ctx.requested).toHaveLength(0);
      expect(() => ecbChunks('2021-01-01', 'soon')).toThrow(/bad range/);
    });

    it('refuses two different rates for one day across parts', async () => {
      const clash = (url: URL) =>
        [
          header,
          line(
            'JPY',
            '2020-06-01',
            url.searchParams.get('startPeriod')!.startsWith('1999') ? '160.00' : '161.00',
          ),
          line('USD', '2020-06-01', '1.2500'),
        ].join('\n');
      await expect(
        ecb.fetchRates('USDJPY', '1999-01-01', '2026-10-28', fixtureContext(clash)),
      ).rejects.toThrow(/two rates for JPY on 2020-06-01/);
    });
  });

  describe('parts with no data', () => {
    const header = csv.split('\n')[0]!;
    const noResults = () => new Response('No results found.', { status: 404 });
    // QQQ (made up): its series ends in 2004, so the later parts have no results.
    const ended = (url: URL) => {
      const start = url.searchParams.get('startPeriod')!;
      if (start > '2004-12-31') return noResults();
      return `${header}\nEXR.D.QQQ.EUR.SP00.A,D,QQQ,EUR,SP00,A,${start},2.5000`;
    };
    const isFirst = (url: URL) => url.searchParams.has('firstNObservations');
    /** Answers the first-observation request with these series starts, other requests by `route`. */
    const withFirst =
      (starts: Record<string, string>, route: (url: URL) => unknown) => (url: URL) =>
        isFirst(url)
          ? [
              header,
              ...Object.entries(starts).map(
                ([cur, date]) => `EXR.D.${cur}.EUR.SP00.A,D,${cur},EUR,SP00,A,${date},1.0000`,
              ),
            ].join('\n')
          : route(url);

    it('counts a part answering 404 or nothing as zero rows', async () => {
      const ctx = fixtureContext(ended);
      const rates = await ecb.fetchRates('EURQQQ', '1999-01-01', '2026-10-28', ctx);
      expect(ctx.requested.length).toBeGreaterThan(2);
      expect(rates.map((r) => r.date)).toEqual(['1999-01-01', expect.any(String)]);
      expect(rates.every((r) => r.rate === 2.5 && r.date <= '2004-12-31')).toBe(true);
      // The first part has rates: no first-observation request.
      expect(ctx.requested.some((u) => isFirst(new URL(u)))).toBe(false);
      const second = ecbChunks('1999-01-01', '2026-10-28')[1]!.from;
      const blank = fixtureContext(
        withFirst({ QQQ: second }, (url) =>
          url.searchParams.get('startPeriod') === '1999-01-01' ? '' : ended(url),
        ),
      );
      expect(
        (await ecb.fetchRates('EURQQQ', '1999-01-01', '2026-10-28', blank)).map((r) => r.date),
      ).toEqual([second]);
    });

    it('accepts empty parts at the start or end, and refuses a hole between parts with rates', async () => {
      const parts = ecbChunks('1999-01-01', '2026-10-28');
      expect(parts.length).toBeGreaterThan(3);
      const emptyAt = (empty: number[]) => (url: URL) => {
        const start = url.searchParams.get('startPeriod')!;
        const i = parts.findIndex((p) => p.from === start);
        if (empty.includes(i)) return i % 2 === 0 ? noResults() : header;
        return `${header}\nEXR.D.QQQ.EUR.SP00.A,D,QQQ,EUR,SP00,A,${start},2.5000`;
      };
      // Leading and trailing empty parts (a series that started late and ended early): the
      // leading ones are accepted because the ECB says the series starts after them.
      const edgesCtx = fixtureContext(
        withFirst({ QQQ: parts[2]!.from }, emptyAt([0, 1, parts.length - 1])),
      );
      const edges = await ecb.fetchRates('EURQQQ', '1999-01-01', '2026-10-28', edgesCtx);
      expect(edges.map((r) => r.date)).toEqual(parts.slice(2, -1).map((p) => p.from));
      const asked = edgesCtx.requested.map((u) => new URL(u)).filter(isFirst);
      expect(asked).toHaveLength(1);
      expect(asked[0]!.pathname).toMatch(/\/EXR\/D\.QQQ\.EUR\.SP00\.A$/);
      expect(asked[0]!.searchParams.get('firstNObservations')).toBe('1');
      expect(asked[0]!.searchParams.get('detail')).toBe('dataonly');
      expect(asked[0]!.searchParams.get('format')).toBe('csvdata');
      expect(asked[0]!.searchParams.has('startPeriod')).toBe(false);
      // Only trailing empty parts: accepted as before, without asking (FX freshness catches a
      // recent gap).
      const tailCtx = fixtureContext(emptyAt([parts.length - 1]));
      await ecb.fetchRates('EURQQQ', '1999-01-01', '2026-10-28', tailCtx);
      expect(tailCtx.requested.some((u) => isFirst(new URL(u)))).toBe(false);
      // A 404 or header-only part between parts with rates is refused, naming its range.
      for (const hole of [2, 3]) {
        const p = parts[hole]!;
        await expect(
          ecb.fetchRates('EURQQQ', '1999-01-01', '2026-10-28', fixtureContext(emptyAt([hole]))),
        ).rejects.toThrow(
          `ECB: no rates for EURQQQ from ${p.from} to ${p.to}, between parts with rates`,
        );
      }
    });

    it('refuses a leading empty part when the series starts on or before its end', async () => {
      const parts = ecbChunks('1999-01-01', '2026-10-28');
      const span = `from ${parts[0]!.from} to ${parts[0]!.to}`;
      // A leading 404 or a leading header-only answer, for a series the ECB says starts in 1999.
      for (const empty of [noResults, () => header]) {
        const route = (url: URL) =>
          url.searchParams.get('startPeriod') === '1999-01-01' ? empty() : ended(url);
        await expect(
          ecb.fetchRates(
            'EURQQQ',
            '1999-01-01',
            '2026-10-28',
            fixtureContext(withFirst({ QQQ: '1999-01-04' }, route)),
          ),
        ).rejects.toThrow(
          `ECB: no rates for EURQQQ ${span}, but the QQQ series starts on 1999-01-04`,
        );
        // A first observation on the empty part's last day is refused too.
        await expect(
          ecb.fetchRates(
            'EURQQQ',
            '1999-01-01',
            '2026-10-28',
            fixtureContext(withFirst({ QQQ: parts[0]!.to }, route)),
          ),
        ).rejects.toThrow(/but the QQQ series starts on/);
      }
      // Two empty leading parts, the first observation inside the second: the span runs to the
      // end of the last empty part.
      const twoRoute = (url: URL) => {
        const start = url.searchParams.get('startPeriod')!;
        const i = parts.findIndex((p) => p.from === start);
        return i === 0
          ? noResults()
          : i === 1
            ? header
            : `${header}\nEXR.D.QQQ.EUR.SP00.A,D,QQQ,EUR,SP00,A,${start},2.5000`;
      };
      await expect(
        ecb.fetchRates(
          'EURQQQ',
          '1999-01-01',
          '2026-10-28',
          fixtureContext(withFirst({ QQQ: parts[1]!.from }, twoRoute)),
        ),
      ).rejects.toThrow(
        `ECB: no rates for EURQQQ from ${parts[0]!.from} to ${parts[1]!.to}, but the QQQ series starts on ${parts[1]!.from}`,
      );
      // A range starting later: an empty first part of a series that started in 1999 is refused.
      const late = ecbChunks('2010-01-01', '2026-10-28');
      const lateRoute = (url: URL) => {
        const start = url.searchParams.get('startPeriod')!;
        if (start === '2010-01-01') return noResults();
        return `${header}\nEXR.D.QQQ.EUR.SP00.A,D,QQQ,EUR,SP00,A,${start},2.5000`;
      };
      await expect(
        ecb.fetchRates(
          'EURQQQ',
          '2010-01-01',
          '2026-10-28',
          fixtureContext(withFirst({ QQQ: '1999-01-04' }, lateRoute)),
        ),
      ).rejects.toThrow(`from 2010-01-01 to ${late[0]!.to}, but the QQQ series starts on`);
    });

    it('asks once for both currencies of a cross and refuses when either starts too early', async () => {
      const parts = ecbChunks('1999-01-01', '2026-10-28');
      const route = (url: URL) => {
        const start = url.searchParams.get('startPeriod')!;
        if (start === '1999-01-01') return noResults();
        return [
          header,
          `EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,${start},1.2500`,
          `EXR.D.JPY.EUR.SP00.A,D,JPY,EUR,SP00,A,${start},160.00`,
        ].join('\n');
      };
      const later = parts[1]!.from;
      const ctx = fixtureContext(withFirst({ USD: later, JPY: later }, route));
      const rates = await ecb.fetchRates('USDJPY', '1999-01-01', '2026-10-28', ctx);
      expect(rates.map((r) => r.date)).toEqual(parts.slice(1).map((p) => p.from));
      const asked = ctx.requested.map((u) => new URL(u)).filter(isFirst);
      expect(asked).toHaveLength(1);
      expect(asked[0]!.pathname).toMatch(/\/EXR\/D\.USD\+JPY\.EUR\.SP00\.A$/);
      await expect(
        ecb.fetchRates(
          'USDJPY',
          '1999-01-01',
          '2026-10-28',
          fixtureContext(withFirst({ USD: later, JPY: '1999-01-04' }, route)),
        ),
      ).rejects.toThrow(/but the JPY series starts on 1999-01-04/);
      // A currency missing from the answer is unknown, never taken as starting later.
      await expect(
        ecb.fetchRates(
          'USDJPY',
          '1999-01-01',
          '2026-10-28',
          fixtureContext(withFirst({ USD: later }, route)),
        ),
      ).rejects.toThrow(/no first observation for JPY/);
    });

    it('refuses the range when the first observation cannot be read or contradicts the rates', async () => {
      const parts = ecbChunks('1999-01-01', '2026-10-28');
      const route = (url: URL) =>
        url.searchParams.get('startPeriod') === '1999-01-01' ? noResults() : ended(url);
      const failing = (answer: () => unknown) =>
        fixtureContext((url) => (isFirst(url) ? answer() : route(url)));
      // A failed request (an error, or a 404 for a series that just gave rates) fails the range.
      await expect(
        ecb.fetchRates(
          'EURQQQ',
          '1999-01-01',
          '2026-10-28',
          failing(() => new Response('', { status: 500 })),
        ),
      ).rejects.toThrow(/HTTP 500/);
      await expect(
        ecb.fetchRates('EURQQQ', '1999-01-01', '2026-10-28', failing(noResults)),
      ).rejects.toThrow(/HTTP 404/);
      // An empty or header-only answer: unknown start, refused.
      for (const answer of ['', header]) {
        await expect(
          ecb.fetchRates(
            'EURQQQ',
            '1999-01-01',
            '2026-10-28',
            failing(() => answer),
          ),
        ).rejects.toThrow(/no first observation for QQQ/);
      }
      // Unreadable rows or columns are refused.
      for (const answer of [
        `${header}\nEXR.D.QQQ.EUR.SP00.A,D,QQQ,EUR,SP00,A,soon,1.0`,
        'KEY,VALUE\nx,1',
      ]) {
        await expect(
          ecb.fetchRates(
            'EURQQQ',
            '1999-01-01',
            '2026-10-28',
            failing(() => answer),
          ),
        ).rejects.toThrow(/unreadable row|unexpected columns/);
      }
      // A start after a rate already received: the answer cannot vouch for the empty span.
      const after = addDays(parts[1]!.from, 1);
      await expect(
        ecb.fetchRates(
          'EURQQQ',
          '1999-01-01',
          '2026-10-28',
          fixtureContext(withFirst({ QQQ: after }, route)),
        ),
      ).rejects.toThrow(`said to start on ${after}, but has a rate on ${parts[1]!.from}`);
    });

    it('refuses the range when every part is empty', async () => {
      await expect(
        ecb.fetchRates('EURQQQ', '2010-01-01', '2026-10-28', fixtureContext(noResults)),
      ).rejects.toThrow(/^HTTP 404 for .*: No results found\.$/);
      await expect(
        ecb.fetchRates(
          'EURQQQ',
          '2026-01-02',
          '2026-01-05',
          fixtureContext(() => header),
        ),
      ).rejects.toThrow(/no rates for EURQQQ/);
      // Other failures are not taken as empty.
      await expect(
        ecb.fetchRates(
          'EURQQQ',
          '1999-01-01',
          '2026-10-28',
          fixtureContext((url) =>
            url.searchParams.get('startPeriod')! > '2004-12-31'
              ? new Response('', { status: 400 })
              : ended(url),
          ),
        ),
      ).rejects.toThrow(/HTTP 400/);
    });
  });
});

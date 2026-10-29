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

    it('counts a part answering 404 or nothing as zero rows', async () => {
      const ctx = fixtureContext(ended);
      const rates = await ecb.fetchRates('EURQQQ', '1999-01-01', '2026-10-28', ctx);
      expect(ctx.requested.length).toBeGreaterThan(2);
      expect(rates.map((r) => r.date)).toEqual(['1999-01-01', expect.any(String)]);
      expect(rates.every((r) => r.rate === 2.5 && r.date <= '2004-12-31')).toBe(true);
      const blank = fixtureContext((url) =>
        url.searchParams.get('startPeriod') === '1999-01-01' ? '' : ended(url),
      );
      expect(
        (await ecb.fetchRates('EURQQQ', '1999-01-01', '2026-10-28', blank)).map((r) => r.date),
      ).toHaveLength(1);
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
      // Leading and trailing empty parts (a series that started late and ended early).
      const edges = await ecb.fetchRates(
        'EURQQQ',
        '1999-01-01',
        '2026-10-28',
        fixtureContext(emptyAt([0, 1, parts.length - 1])),
      );
      expect(edges.map((r) => r.date)).toEqual(parts.slice(2, -1).map((p) => p.from));
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

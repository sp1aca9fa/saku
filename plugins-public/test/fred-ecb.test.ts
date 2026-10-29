import { fixtureContext } from '@saku/plugin-sdk/testing';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ecb } from '../src/ecb';
import { fredFx, fredSeries } from '../src/fred';
import { fixture } from './fixture';

describe('FRED', () => {
  it('keeps every vintage and leaves out missing values', async () => {
    const ctx = fixtureContext(() => fixture('fred-dtb3.json'), { apiKey: 'abc' });
    expect(await fredSeries.fetchSeries('DTB3', '2026-01-01', '2026-01-06', ctx)).toEqual([
      // The vintage day at 18:00 New York (EST: 23:00 UTC), never its midnight.
      { date: '2026-01-02', value: 3.61, publishedAt: '2026-01-05T23:00:00.000Z' },
      { date: '2026-01-02', value: 3.62, publishedAt: '2026-01-07T23:00:00.000Z' },
      { date: '2026-01-05', value: 3.6, publishedAt: '2026-01-06T23:00:00.000Z' },
    ]);
    const url = new URL(ctx.requested[0]!);
    expect(url.searchParams.get('series_id')).toBe('DTB3');
    expect(url.searchParams.get('realtime_start')).toBe('1776-07-04');
  });

  it('maps FX pairs to H.10 series', async () => {
    const ctx = fixtureContext(() => fixture('fred-dtb3.json'), { apiKey: 'abc' });
    const rates = await fredFx.fetchRates('USDJPY', '2026-01-01', '2026-01-06', ctx);
    expect(new URL(ctx.requested[0]!).searchParams.get('series_id')).toBe('DEXJPUS');
    expect(rates[0]).toEqual({
      pair: 'USDJPY',
      date: '2026-01-02',
      rate: 3.61,
      publishedAt: '2026-01-05T23:00:00.000Z',
    });
    await expect(fredFx.fetchRates('USDXXX', '2026-01-01', '2026-01-06', ctx)).rejects.toThrow();
  });
});

describe('ECB', () => {
  const csv = readFileSync(new URL('fixtures/ecb.csv', import.meta.url), 'utf8');

  it('derives a cross from two euro rates, with the publication time', async () => {
    const ctx = fixtureContext(() => csv);
    const rates = await ecb.fetchRates('USDJPY', '2026-01-02', '2026-01-05', ctx);
    expect(ctx.requested[0]).toContain('/EXR/D.USD+JPY.EUR.SP00.A?');
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
});

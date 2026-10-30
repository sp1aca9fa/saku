import type { RawBar } from '@saku/core';
import { describe, expect, it } from 'vitest';
import { Sessions } from './calendar';
import {
  adjReturnCheck,
  checkAsRead,
  fxCheck,
  fxUnavailable,
  indexCheck,
  indexUnavailable,
  layerA,
  layerB,
  leverageCheck,
  moveThreshold,
  unsplit,
} from './checks';

const sessions = new Sessions({
  id: 't',
  version: 't',
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
  holidays: [],
});
const bar = (date: string, close: number, extra: Partial<RawBar> = {}): RawBar => ({
  date,
  open: close,
  high: close,
  low: close,
  close,
  closeIsSplitAdjusted: false,
  volume: 1000,
  divCash: 0,
  splitFactor: 1,
  ...extra,
});
const statuses = (rs: { check: string; date: string; status: string }[], check: string) =>
  rs.filter((r) => r.check === check).map((r) => `${r.date} ${r.status}`);

describe('layer A', () => {
  const opts = { source: 'p', primary: true, leverage: 1, sessions };

  it('passes clean bars and fails broken ones red', () => {
    const rs = layerA(
      [
        bar('2026-01-05', 10),
        bar('2026-01-06', 11, { high: 10.5 }),
        bar('2026-01-07', 11.1, { low: -1 }),
      ],
      opts,
    );
    expect(statuses(rs, 'bar_valid')).toEqual([
      '2026-01-05 green',
      '2026-01-06 red',
      '2026-01-07 red',
    ]);
    expect(rs.find((r) => r.date === '2026-01-06' && r.check === 'bar_valid')?.message).toBe(
      'high below open or close',
    );
  });

  it('flags large moves by leverage and unchanged closes yellow', () => {
    expect(moveThreshold(1)).toBe(0.25);
    expect(moveThreshold(3)).toBe(0.6);
    const rs = layerA([bar('2026-01-05', 10), bar('2026-01-06', 13), bar('2026-01-07', 13)], opts);
    expect(statuses(rs, 'large_move')).toEqual(['2026-01-06 yellow', '2026-01-07 green']);
    expect(statuses(rs, 'unchanged_close')).toEqual(['2026-01-06 green', '2026-01-07 yellow']);
    const lev = layerA([bar('2026-01-05', 10), bar('2026-01-06', 13)], { ...opts, leverage: 3 });
    expect(statuses(lev, 'large_move')).toEqual(['2026-01-06 green']);
  });

  it('a missing session is red for the primary, yellow otherwise; weekends are not sessions', () => {
    const bars = [bar('2026-01-02', 10), bar('2026-01-06', 10.1), bar('2026-01-10', 10.2)];
    expect(statuses(layerA(bars, opts), 'missing_day')).toEqual([
      '2026-01-05 red',
      '2026-01-07 red',
      '2026-01-08 red',
      '2026-01-09 red',
    ]);
    expect(statuses(layerA(bars, { ...opts, primary: false }), 'missing_day')[0]).toBe(
      '2026-01-05 yellow',
    );
    expect(statuses(layerA(bars, opts), 'bar_valid')[2]).toBe('2026-01-10 red'); // a Saturday
  });
});

describe('unsplit', () => {
  it('restates split-adjusted prices as traded, using the source’s own splits', () => {
    const adjusted = [
      bar('2026-01-05', 50, { closeIsSplitAdjusted: true, volume: 2000, divCash: 0.25 }),
      bar('2026-01-06', 51, { closeIsSplitAdjusted: true, splitFactor: 2 }),
    ];
    const real = unsplit(adjusted);
    expect(real[0]).toMatchObject({
      close: 100,
      volume: 1000,
      divCash: 0.5,
      closeIsSplitAdjusted: false,
    });
    expect(real[1]).toMatchObject({ close: 51, splitFactor: 2 });
  });
});

describe('layer B', () => {
  const p = [
    bar('2026-01-05', 100),
    bar('2026-01-06', 101, { divCash: 0.5 }),
    bar('2026-01-07', 102),
  ];

  it('compares closes: 0.05% green, up to 2x yellow, beyond red; a missing bar yellow', () => {
    const s = [bar('2026-01-05', 100.04), bar('2026-01-06', 101.08, { divCash: 0.5 })];
    const rs = layerB(p, s, 's');
    expect(statuses(rs, 'close_match')).toEqual(['2026-01-05 green', '2026-01-06 yellow']);
    // The date the secondary lacks is its own check, never a close disagreement.
    expect(rs.filter((r) => r.check === 'secondary_missing')).toEqual([
      {
        layer: 'B',
        source: 's',
        check: 'secondary_missing',
        date: '2026-01-07',
        status: 'yellow',
        message: 'no secondary bar',
      },
    ]);
    expect(statuses(layerB(p, [bar('2026-01-05', 101)], 's'), 'close_match')[0]).toBe(
      '2026-01-05 red',
    );
  });

  it('reads a missing bar stored before secondary_missing as secondary_missing', () => {
    const old = { layer: 'B', checkName: 'close_match', message: 'no secondary bar' };
    expect(checkAsRead(old)).toBe('secondary_missing');
    expect(checkAsRead({ ...old, message: null })).toBe('close_match');
    expect(checkAsRead({ ...old, layer: 'D' })).toBe('close_match');
    expect(checkAsRead({ layer: 'B', checkName: 'secondary_missing' })).toBe('secondary_missing');
  });

  it('requires events on the same dates within 1%', () => {
    const moved = [
      bar('2026-01-05', 100, { divCash: 0.5 }),
      bar('2026-01-06', 101),
      bar('2026-01-07', 102),
    ];
    expect(statuses(layerB(p, moved, 's'), 'dividend_match')).toEqual([
      '2026-01-05 red',
      '2026-01-06 red',
    ]);
    const close = [
      bar('2026-01-05', 100),
      bar('2026-01-06', 101, { divCash: 0.503 }),
      bar('2026-01-07', 102),
    ];
    expect(statuses(layerB(p, close, 's'), 'dividend_match')).toEqual(['2026-01-06 green']);
  });

  it('compares daily returns of our adjusted series with a provider’s adjusted closes', () => {
    // A provider adjusted series scaled by any constant has the same returns.
    const provider = p.map((b, i) => ({ ...b, providerAdjClose: [50, 50.75, 51.25][i]! }));
    const rs = adjReturnCheck(p, provider, 'p');
    expect(statuses(rs, 'adj_return_match')).toEqual(['2026-01-06 green', '2026-01-07 green']);
    const off = p.map((b, i) => ({ ...b, providerAdjClose: [50, 50.5, 51][i]! }));
    expect(statuses(adjReturnCheck(p, off, 'p'), 'adj_return_match')[0]).toBe('2026-01-06 red');
  });

  it('compares FX within 0.5%', () => {
    const rs = fxCheck([{ date: 'd', rate: 150 }], [{ date: 'd', rate: 150.6 }], 's');
    expect(rs[0]).toMatchObject({ status: 'green' });
    expect(fxCheck([{ date: 'd', rate: 150 }], [{ date: 'd', rate: 151.2 }], 's')[0]?.status).toBe(
      'yellow',
    );
  });

  it('is yellow where only the secondary has a rate, unless the primary declares the day closed', () => {
    const p = [
      { date: '2026-01-05', rate: 150 },
      { date: '2026-01-07', rate: 150 },
    ];
    const s = ['2026-01-02', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'].map(
      (date) => ({ date, rate: 150 }),
    );
    // 01-02: before the primary's history; 01-06 and 01-08: the cross-check could not run.
    expect(fxCheck(p, s, 's').map((r) => `${r.date} ${r.check} ${r.status}`)).toEqual([
      '2026-01-05 fx_match green',
      '2026-01-06 fx_unavailable yellow',
      '2026-01-07 fx_match green',
      '2026-01-08 fx_unavailable yellow',
    ]);
    // A declared closing day of the primary is an expected gap.
    const closed = (d: string) => d === '2026-01-06';
    expect(fxCheck(p, s, 's', { closed }).map((r) => r.check)).toEqual([
      'fx_match',
      'fx_match',
      'fx_unavailable',
    ]);
    // No primary rate at all: nothing here (the caller grades the run's date).
    expect(fxCheck([], s, 's')).toEqual([]);
  });
});

describe('layer C', () => {
  const spy = [
    bar('2026-01-05', 100),
    bar('2026-01-06', 102),
    bar('2026-01-07', 101, { divCash: 1 }),
  ];

  it('tracks leverage against the underlying’s price return', () => {
    // +2% then -0.98% (price, the dividend excluded) at 2x.
    const sso = [bar('2026-01-05', 50), bar('2026-01-06', 52), bar('2026-01-07', 50.98)];
    expect(statuses(leverageCheck(sso, spy, 2), 'leverage_track')).toEqual([
      '2026-01-06 green',
      '2026-01-07 green',
    ]);
    const off = [bar('2026-01-05', 50), bar('2026-01-06', 51), bar('2026-01-07', 50.98)];
    expect(statuses(leverageCheck(off, spy, 2), 'leverage_track')[0]).toBe('2026-01-06 yellow');
  });

  it('is red after three days in a row outside tolerance', () => {
    const u = [100, 101, 102, 103, 104].map((c, i) => bar(`2026-01-0${i + 5}`, c));
    const f = [100, 100, 100, 100, 100].map((c, i) => bar(`2026-01-0${i + 5}`, c));
    expect(statuses(leverageCheck(f, u, 2), 'leverage_track').map((s) => s.slice(11))).toEqual([
      'yellow',
      'yellow',
      'red',
      'red',
    ]);
  });

  it('matches a fund’s price return to its index', () => {
    const index = [
      { date: '2026-01-05', value: 5000 },
      { date: '2026-01-06', value: 5100 },
      { date: '2026-01-07', value: 5050 },
    ];
    expect(statuses(indexCheck(spy, index), 'index_match')).toEqual([
      '2026-01-06 green',
      '2026-01-07 green',
    ]);
  });

  it('is yellow where the index lacks a value inside its history, never green', () => {
    const four = [...spy, bar('2026-01-08', 102)];
    const index = [
      { date: '2026-01-05', value: 5000 },
      { date: '2026-01-07', value: 5050 },
      { date: '2026-01-08', value: 5100 },
    ];
    // 01-06 is missing: both returns that need it cannot be compared.
    const rs = indexCheck(four, index, { source: 'idx', to: '2026-01-08' });
    expect(rs.map((r) => `${r.date} ${r.check} ${r.status} ${r.source}`)).toEqual([
      '2026-01-06 index_unavailable yellow idx',
      '2026-01-07 index_unavailable yellow idx',
      '2026-01-08 index_match green idx',
    ]);
  });

  it('starts where the index history starts (a provider limit is not a gap)', () => {
    const index = [
      { date: '2026-01-06', value: 5100 },
      { date: '2026-01-07', value: 5050 },
    ];
    expect(statuses(indexCheck(spy, index), 'index_match')).toEqual(['2026-01-07 green']);
    expect(indexCheck(spy, index).some((r) => r.check === 'index_unavailable')).toBe(false);
  });

  it('leaves only the run date to the next run when just that day is not yet published', () => {
    const index = [
      { date: '2026-01-05', value: 5000 },
      { date: '2026-01-06', value: 5100 },
    ];
    // The run's own day: the publication lag (the next run's window checks it again).
    expect(indexCheck(spy, index, { to: '2026-01-07' }).map((r) => r.check)).toEqual([
      'index_match',
    ]);
    // Any other date, or with no run date given: the check could not run, yellow.
    expect(indexCheck(spy, index).map((r) => `${r.date} ${r.check}`)).toEqual([
      '2026-01-06 index_match',
      '2026-01-07 index_unavailable',
    ]);
    // Two days behind on the run's date: yellow on both, the run's date included.
    const behind = [{ date: '2026-01-05', value: 5000 }];
    expect(indexCheck(spy, behind, { to: '2026-01-07' }).map((r) => r.status)).toEqual([
      'yellow',
      'yellow',
    ]);
  });

  it('gives nothing for an empty index (the caller grades a series with no value)', () => {
    expect(indexCheck(spy, [], { to: '2026-01-07' })).toEqual([]);
    expect(indexUnavailable('2026-01-07', 'idx')).toMatchObject({
      layer: 'C',
      check: 'index_unavailable',
      status: 'yellow',
      source: 'idx',
    });
    expect(fxUnavailable('2026-01-07', 's')).toMatchObject({
      layer: 'B',
      check: 'fx_unavailable',
      status: 'yellow',
      source: 's',
    });
  });
});

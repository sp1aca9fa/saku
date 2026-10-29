import type { IssuerRecord, RawBar } from '@saku/core';
import { describe, expect, it } from 'vitest';
import { Sessions } from './calendar';
import { LAYER_D_MAX_STATUS, layerD, navPremiums, premiumStats, quantile } from './issuer';

const sessions = new Sessions({
  id: 't',
  version: 't',
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
  holidays: [],
});
const dates = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'];
const TO = '2026-01-09';
const bar = (date: string, close: number, extra: Partial<RawBar> = {}): RawBar => ({
  date,
  close,
  closeIsSplitAdjusted: false,
  divCash: 0,
  splitFactor: 1,
  ...extra,
});
// A fund at 100, paying 0.5 on the 7th and splitting 2:1 on the 8th.
const primary = [
  bar(dates[0]!, 100),
  bar(dates[1]!, 100.2),
  bar(dates[2]!, 100.1, { divCash: 0.5 }),
  bar(dates[3]!, 50.1, { splitFactor: 2 }),
  bar(dates[4]!, 50.2),
];
const navs = (premium = 0): IssuerRecord[] =>
  primary.map((b) => ({
    date: b.date,
    nav: b.close / (1 + premium),
    currency: 'USD',
    ...(b.divCash > 0 && { distribution: b.divCash }),
    ...(b.splitFactor !== 1 && { split: b.splitFactor }),
  }));
const opts = { source: 'iss', currency: 'USD', sessions, to: TO };
const of = (rs: ReturnType<typeof layerD>, check: string) => rs.filter((r) => r.check === check);

describe('layer D (issuer reconciliation)', () => {
  it('is green on matching data, one result per check and date', () => {
    const rs = layerD(primary, navs(0.001), { ...opts, tolerance: 0.005 });
    expect(rs.every((r) => r.layer === 'D' && r.source === 'iss')).toBe(true);
    expect(rs.every((r) => r.status === 'green')).toBe(true);
    expect(of(rs, 'nav_premium')).toHaveLength(5);
    expect(of(rs, 'nav_premium')[0]!.deviation).toBeCloseTo(0.001, 12);
    expect(of(rs, 'distribution_match').map((r) => r.date)).toEqual([dates[2]]);
    expect(of(rs, 'split_match').map((r) => r.date)).toEqual([dates[3]]);
    expect(of(rs, 'issuer_stale')).toEqual([
      expect.objectContaining({ date: TO, status: 'green', observed: 0 }),
    ]);
  });

  it('without a tolerance the premium is observed only: green, the deviation recorded', () => {
    const rs = of(layerD(primary, navs(0.1), opts), 'nav_premium');
    expect(rs.every((r) => r.status === 'green' && r.tolerance === undefined)).toBe(true);
    expect(rs[0]!.deviation).toBeCloseTo(0.1, 12);
    expect(rs[0]!.message).toMatch(/observed only/);
  });

  it('grades the premium against the tolerance, never above the advisory cap', () => {
    expect(LAYER_D_MAX_STATUS).toBe('yellow');
    const status = (premium: number) =>
      of(layerD(primary, navs(premium), { ...opts, tolerance: 0.01 }), 'nav_premium')[0]!.status;
    expect(status(0.0099)).toBe('green');
    expect(status(-0.015)).toBe('yellow');
    // Above 2x tolerance would be red under the severity rules: capped while advisory.
    expect(status(0.1)).toBe('yellow');
  });

  it('a NAV that is not positive is a mismatch (capped), never a premium', () => {
    const records = navs().map((r, i) => (i === 1 ? { ...r, nav: 0 } : r));
    const r = of(layerD(primary, records, opts), 'nav_premium')[1]!;
    expect(r).toMatchObject({ status: 'yellow', message: 'issuer NAV not positive' });
    expect(r.deviation).toBeUndefined();
    expect(navPremiums(primary, records, 'USD')).toHaveLength(4);
  });

  it("compares a NAV only in the fund's currency: another or none is a mismatch (capped)", () => {
    const records = navs().map((r, i) =>
      i === 0 ? { ...r, currency: 'XXX' } : i === 1 ? { date: r.date, nav: r.nav! } : r,
    );
    const rs = of(layerD(primary, records, { ...opts, tolerance: 0.01 }), 'nav_premium');
    expect(rs[0]).toMatchObject({
      status: 'yellow',
      message: 'NAV currency differs (XXX, the fund trades in USD)',
    });
    expect(rs[0]!.deviation).toBeUndefined();
    expect(rs[1]!.message).toMatch(/differs \(none,/);
    expect(rs[2]!.status).toBe('green');
    expect(navPremiums(primary, records, 'USD').map((p) => p.date)).toEqual(dates.slice(2));
  });

  it('a split-adjusted NAV history (not as published that day) shows as a mismatch', () => {
    // The issuer restated NAVs before the 2:1 split on today's share basis (halved).
    const adjusted = navs().map((r, i) => (i < 3 ? { ...r, nav: r.nav! / 2 } : r));
    const rs = of(layerD(primary, adjusted, { ...opts, tolerance: 0.01 }), 'nav_premium');
    expect(rs.map((r) => r.status)).toEqual(['yellow', 'yellow', 'yellow', 'green', 'green']);
    expect(rs[0]!.deviation).toBeCloseTo(1, 12);
  });

  it('flags a distribution or split on one side only, and amounts beyond 1%', () => {
    const missed = navs().map((r) => ({ ...r, distribution: undefined }));
    const d = of(layerD(primary, missed, opts), 'distribution_match');
    expect(d).toEqual([
      expect.objectContaining({
        date: dates[2],
        status: 'yellow',
        message: 'event missing in issuer data',
      }),
    ]);
    const extra = navs().map((r, i) => (i === 1 ? { ...r, distribution: 0.3 } : r));
    expect(of(layerD(primary, extra, opts), 'distribution_match')[0]).toMatchObject({
      date: dates[1],
      status: 'yellow',
      message: 'event only in issuer data',
    });
    const off = navs().map((r) => (r.distribution ? { ...r, distribution: 0.504 } : r));
    expect(of(layerD(primary, off, opts), 'distribution_match')[0]!.status).toBe('green');
    const wrong = navs().map((r) => (r.split ? { ...r, split: 3 } : r));
    expect(of(layerD(primary, wrong, opts), 'split_match')[0]).toMatchObject({
      status: 'yellow',
      observed: 3,
      expected: 2,
    });
  });

  it('a NAV source without a record on an event date: not compared, never a mismatch', () => {
    const gap = navs().filter((r) => r.date !== dates[2]);
    const d = of(layerD(primary, gap, opts), 'distribution_match');
    expect(d).toEqual([
      expect.objectContaining({
        date: dates[2],
        status: 'yellow',
        message: 'not compared: the issuer has no record on this date',
      }),
    ]);
    expect(d[0]!.observed).toBeUndefined();
    // After the issuer's last record its staleness speaks, not the events.
    expect(of(layerD(primary, navs().slice(0, 2), opts), 'distribution_match')).toEqual([]);
  });

  it('compares events only within the dates both sides cover', () => {
    // The issuer starts after the distribution: the primary's earlier event is not a mismatch.
    const late = navs().slice(3);
    expect(of(layerD(primary, late, opts), 'distribution_match')).toEqual([]);
    expect(of(layerD(primary, late, opts), 'split_match')).toHaveLength(1);
    // Distribution-only source: no NAV, so no premium and no freshness check.
    const events = navs()
      .filter((r) => r.distribution || r.split)
      .map(({ nav: _nav, ...r }) => r);
    const rs = layerD(primary, events, opts);
    expect(of(rs, 'nav_premium')).toEqual([]);
    expect(of(rs, 'issuer_stale')).toEqual([]);
    expect(rs.every((r) => r.status === 'green')).toBe(true);
  });

  it('is stale when the latest NAV is more than one session behind the run date', () => {
    const behind = (n: number) =>
      of(layerD(primary, navs().slice(0, 5 - n), opts), 'issuer_stale')[0]!;
    expect(behind(1)).toMatchObject({ status: 'green', observed: 1 });
    expect(behind(2)).toMatchObject({ status: 'yellow', observed: 2, date: TO });
    expect(behind(4).status).toBe('yellow');
  });

  it('with no NAV stored: yellow when this run failed for the fund or a supported fund has none', () => {
    const stale = (rs: ReturnType<typeof layerD>) => of(rs, 'issuer_stale');
    expect(stale(layerD(primary, [], { ...opts, unavailable: true }))).toEqual([
      expect.objectContaining({
        date: TO,
        status: 'yellow',
        message: 'not fetched, no NAV stored',
      }),
    ]);
    expect(stale(layerD(primary, [], { ...opts, supported: true }))).toEqual([
      expect.objectContaining({ status: 'yellow', message: 'supported, no record stored' }),
    ]);
    // An events-only source that delivered records has no freshness; failing this run, it has.
    const events = navs()
      .filter((r) => r.distribution)
      .map(({ nav: _n, currency: _c, ...r }) => r);
    expect(stale(layerD(primary, events, { ...opts, supported: true }))).toEqual([]);
    expect(stale(layerD(primary, events, { ...opts, unavailable: true }))[0]!.status).toBe(
      'yellow',
    );
    // A run failure with a NAV stored: its age decides (yesterday's NAV is on time).
    expect(
      stale(layerD(primary, navs().slice(0, 4), { ...opts, unavailable: true }))[0]!.status,
    ).toBe('green');
  });

  it('an invalid tolerance setting observes premiums only and says so (yellow)', () => {
    const rs = layerD(primary, navs(0.1), { ...opts, tolerance: 0.01, toleranceInvalid: true });
    expect(of(rs, 'nav_premium').every((r) => r.status === 'green' && !r.tolerance)).toBe(true);
    expect(of(rs, 'nav_tolerance_invalid')).toEqual([
      expect.objectContaining({ date: TO, status: 'yellow' }),
    ]);
    const events = navs()
      .filter((r) => r.split)
      .map(({ nav: _n, ...r }) => r);
    expect(
      of(layerD(primary, events, { ...opts, toleranceInvalid: true }), 'nav_tolerance_invalid'),
    ).toEqual([]);
  });

  it('ignores records after the run date and returns nothing without records', () => {
    const later = [...navs(), { date: '2026-01-12', nav: 1, currency: 'USD' }];
    expect(of(layerD(primary, later, opts), 'nav_premium')).toHaveLength(5);
    expect(layerD(primary, [], opts)).toEqual([]);
    expect(layerD([], navs(), opts).map((r) => r.check)).toEqual(['issuer_stale']);
  });
});

describe('premium stats', () => {
  it('interpolates quantiles between ranks (type 7)', () => {
    expect(quantile([], 0.5)).toBeUndefined();
    expect(quantile([3], 0.99)).toBe(3);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([0, 10], 0.99)).toBeCloseTo(9.9, 12);
  });

  it('summarizes |premium|, leaving out values that are not finite', () => {
    expect(premiumStats([])).toEqual({ days: 0 });
    expect(premiumStats([-0.002])).toEqual({ days: 1, median: 0.002, p99: 0.002, max: 0.002 });
    const s = premiumStats([0.001, -0.003, 0.002, NaN, Infinity]);
    expect(s.days).toBe(3);
    expect(s.median).toBeCloseTo(0.002, 15);
    expect(s.max).toBeCloseTo(0.003, 15);
    expect(s.p99).toBeCloseTo(0.00298, 12);
  });
});

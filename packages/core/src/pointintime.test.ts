import { describe, expect, it } from 'vitest';
import { PointInTime } from './pointintime';

const pit = new PointInTime([
  { date: '2026-01-05', value: 4.0, knownAt: '2026-01-06T21:00:00Z' },
  { date: '2026-01-06', value: 4.1, knownAt: '2026-01-07T21:00:00Z' },
  // A revision of 01-06 published later.
  { date: '2026-01-06', value: 4.15, knownAt: '2026-01-09T21:00:00Z' },
  { date: '2026-01-07', value: 4.2, knownAt: '2026-01-08T21:00:00Z' },
]);

describe('PointInTime', () => {
  it('reads the last value known at the moment, one day behind for a daily series', () => {
    // At 01-07's open, 01-06 is not published yet: 01-05's value.
    expect(pit.asOf('2026-01-07', '2026-01-07T14:30:00Z')).toMatchObject({
      date: '2026-01-05',
      value: 4.0,
    });
    expect(pit.asOf('2026-01-07', '2026-01-08T01:00:00Z')).toMatchObject({
      date: '2026-01-06',
      value: 4.1,
    });
  });

  it('uses a revision only from when it was published', () => {
    expect(pit.asOf('2026-01-06', '2026-01-08T00:00:00Z')!.value).toBe(4.1);
    expect(pit.asOf('2026-01-06', '2026-01-10T00:00:00Z')!.value).toBe(4.15);
  });

  it('knows nothing before the first publication, unless a backtest asks for first-known values', () => {
    expect(pit.asOf('2026-01-05', '2026-01-05T12:00:00Z')).toBeUndefined();
    expect(pit.asOf('2026-01-05', '2026-01-05T12:00:00Z', { firstKnown: true })).toMatchObject({
      value: 4.0,
      firstKnown: true,
    });
    expect(pit.asOf('2026-01-02', '2026-02-01T00:00:00Z')).toBeUndefined();
  });

  it('lists the observations known at a moment, each in its version known then', () => {
    expect(pit.knownAt('2026-01-08T01:00:00Z')).toEqual([
      { date: '2026-01-05', value: 4.0 },
      { date: '2026-01-06', value: 4.1 },
    ]);
    expect(pit.knownAt('2026-01-10T00:00:00Z').map((p) => p.value)).toEqual([4.0, 4.15, 4.2]);
    expect(pit.knownAt('2026-01-01T00:00:00Z')).toEqual([]);
  });
});

describe('PointInTime withdrawals', () => {
  // 01-06 published 4.1, withdrawn on 01-09 (the source no longer has a value), restored 01-12.
  const rows = [
    { date: '2026-01-05', value: 4.0, knownAt: '2026-01-06T21:00:00Z' },
    { date: '2026-01-06', value: 4.1, knownAt: '2026-01-07T21:00:00Z' },
    { date: '2026-01-06', withdrawn: true as const, knownAt: '2026-01-09T21:00:00Z' },
    { date: '2026-01-06', value: 4.12, knownAt: '2026-01-12T21:00:00Z' },
  ];
  const w = new PointInTime(rows);

  it('reads the old value before the withdrawal, and looks back from it on', () => {
    expect(w.asOf('2026-01-06', '2026-01-08T00:00:00Z')).toMatchObject({
      date: '2026-01-06',
      value: 4.1,
    });
    // Withdrawn: 01-06 has no value, so the read looks back to 01-05 (never 4.1, never 0).
    expect(w.asOf('2026-01-06', '2026-01-10T00:00:00Z')).toMatchObject({
      date: '2026-01-05',
      value: 4.0,
      firstKnown: false,
    });
    // Exactly at the withdrawal's knownAt it counts (known from its own time on).
    expect(w.asOf('2026-01-06', '2026-01-09T21:00:00Z')!.date).toBe('2026-01-05');
  });

  it('counts a later restoring value again', () => {
    expect(w.asOf('2026-01-06', '2026-01-13T00:00:00Z')).toMatchObject({
      date: '2026-01-06',
      value: 4.12,
    });
  });

  it('gives no value when nothing within the look-back has one', () => {
    const only = new PointInTime([
      { date: '2026-01-06', value: 4.1, knownAt: '2026-01-07T21:00:00Z' },
      { date: '2026-01-06', withdrawn: true, knownAt: '2026-01-09T21:00:00Z' },
    ]);
    expect(only.asOf('2026-01-07', '2026-01-10T00:00:00Z')).toBeUndefined();
    // A known withdrawal means the history had started: no first-known value either.
    expect(only.asOf('2026-01-07', '2026-01-10T00:00:00Z', { firstKnown: true })).toBeUndefined();
    // Before the withdrawal, the old value.
    expect(only.asOf('2026-01-07', '2026-01-08T00:00:00Z')!.value).toBe(4.1);
  });

  it('stops looking back after the look-back limit', () => {
    // 2026-01-01 has a value; the 10 dates after it are all withdrawn.
    const dates = Array.from({ length: 10 }, (_, k) => `2026-01-${String(k + 2).padStart(2, '0')}`);
    const many = new PointInTime([
      { date: '2026-01-01', value: 1, knownAt: '2026-01-01T21:00:00Z' },
      ...dates.flatMap((date) => [
        { date, value: 2, knownAt: '2026-01-20T21:00:00Z' },
        { date, withdrawn: true as const, knownAt: '2026-01-21T21:00:00Z' },
      ]),
    ]);
    expect(many.asOf('2026-01-11', '2026-01-22T00:00:00Z')).toBeUndefined();
    // Nine withdrawn dates back: 01-01 is within the look-back.
    expect(many.asOf('2026-01-10', '2026-01-22T00:00:00Z')).toMatchObject({
      date: '2026-01-01',
      value: 1,
    });
  });

  it('never gives a withdrawal as a first-known value', () => {
    const odd = new PointInTime([
      { date: '2026-01-05', value: 4.0, knownAt: '2026-01-06T21:00:00Z' },
      // A withdrawal as the first version (no earlier value stored for the date).
      { date: '2026-01-06', withdrawn: true, knownAt: '2026-01-09T21:00:00Z' },
    ]);
    // Nothing known on 01-06 yet: the first-known fallback skips 01-06 and takes 01-05.
    expect(odd.asOf('2026-01-06', '2026-01-06T00:00:00Z', { firstKnown: true })).toMatchObject({
      date: '2026-01-05',
      value: 4.0,
      firstKnown: true,
    });
    const none = new PointInTime([
      { date: '2026-01-06', withdrawn: true, knownAt: '2026-01-09T21:00:00Z' },
    ]);
    expect(none.asOf('2026-01-06', '2026-01-06T00:00:00Z', { firstKnown: true })).toBeUndefined();
  });

  it('leaves a withdrawn observation out of knownAt until it is restored', () => {
    expect(w.knownAt('2026-01-08T00:00:00Z')).toEqual([
      { date: '2026-01-05', value: 4.0 },
      { date: '2026-01-06', value: 4.1 },
    ]);
    expect(w.knownAt('2026-01-10T00:00:00Z')).toEqual([{ date: '2026-01-05', value: 4.0 }]);
    expect(w.knownAt('2026-01-13T00:00:00Z')).toEqual([
      { date: '2026-01-05', value: 4.0 },
      { date: '2026-01-06', value: 4.12 },
    ]);
  });

  it('breaks a tie in knownAt by the order given (the later fetch wins)', () => {
    const at = '2026-01-07T21:00:00Z';
    const valueThenWithdrawal = new PointInTime([
      { date: '2026-01-06', value: 4.1, knownAt: at },
      { date: '2026-01-06', withdrawn: true, knownAt: at },
    ]);
    expect(valueThenWithdrawal.knownAt(at)).toEqual([]);
    const withdrawalThenValue = new PointInTime([
      { date: '2026-01-06', withdrawn: true, knownAt: at },
      { date: '2026-01-06', value: 4.1, knownAt: at },
    ]);
    expect(withdrawalThenValue.knownAt(at)).toEqual([{ date: '2026-01-06', value: 4.1 }]);
  });
});

describe('PointInTime vintage time (restated vintages)', () => {
  // 3.6 published 01-06, withdrawn by the 01-08 vintage, 3.7 published 01-12, then on 01-14 the
  // source restates the 01-08 vintage as 3.65 (known from that fetch).
  const t = (d: string) => `${d}T23:00:00.000Z`;
  const rows = [
    { date: '2026-01-05', value: 3.6, knownAt: t('2026-01-06'), vintageAt: t('2026-01-06') },
    {
      date: '2026-01-05',
      withdrawn: true as const,
      knownAt: t('2026-01-08'),
      vintageAt: t('2026-01-08'),
    },
    { date: '2026-01-05', value: 3.7, knownAt: t('2026-01-12'), vintageAt: t('2026-01-12') },
    { date: '2026-01-05', value: 3.65, knownAt: t('2026-01-14'), vintageAt: t('2026-01-08') },
  ];
  const p = new PointInTime(rows);

  it('counts a restatement only from when it was known', () => {
    expect(p.asOf('2026-01-05', t('2026-01-07'))!.value).toBe(3.6);
    expect(p.asOf('2026-01-05', t('2026-01-10'))).toBeUndefined();
  });

  it('never lets a restated older vintage outrank a newer one', () => {
    expect(p.asOf('2026-01-05', t('2026-01-13'))!.value).toBe(3.7);
    expect(p.asOf('2026-01-05', t('2026-01-15'))).toMatchObject({
      value: 3.7,
      knownAt: t('2026-01-12'),
    });
    expect(p.knownAt(t('2026-01-15'))).toEqual([{ date: '2026-01-05', value: 3.7 }]);
    // The order the rows are given in does not change that.
    expect(new PointInTime([...rows].reverse()).asOf('2026-01-05', t('2026-01-15'))!.value).toBe(
      3.7,
    );
  });

  it('a restatement of the newest vintage wins over the original from its fetch', () => {
    const r = new PointInTime([
      { date: '2026-01-05', value: 3.6, knownAt: t('2026-01-06'), vintageAt: t('2026-01-06') },
      { date: '2026-01-05', value: 3.62, knownAt: t('2026-01-09'), vintageAt: t('2026-01-06') },
    ]);
    expect(r.asOf('2026-01-05', t('2026-01-08'))!.value).toBe(3.6);
    expect(r.asOf('2026-01-05', t('2026-01-09'))!.value).toBe(3.62);
  });

  it('first-known gives what was known first, not a later restatement of an older vintage', () => {
    const r = new PointInTime([
      { date: '2026-01-05', value: 3.7, knownAt: t('2026-01-12'), vintageAt: t('2026-01-12') },
      // An older vintage first stored late (restated): ranked first, but known later.
      { date: '2026-01-05', value: 3.65, knownAt: t('2026-01-14'), vintageAt: t('2026-01-08') },
    ]);
    expect(r.asOf('2026-01-05', t('2026-01-01'), { firstKnown: true })).toMatchObject({
      value: 3.7,
      firstKnown: true,
    });
  });

  it('refuses a version known before its own vintage time', () => {
    expect(
      () =>
        new PointInTime([
          { date: '2026-01-05', value: 1, knownAt: t('2026-01-06'), vintageAt: t('2026-01-07') },
        ]),
    ).toThrow(/before its vintage time/);
  });
});

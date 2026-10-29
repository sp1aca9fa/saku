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

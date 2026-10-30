import { describe, expect, it } from 'vitest';
import { schema } from './index';
import { testDb } from './testing';
import {
  USAGE_SYMBOL_WINDOW_MS,
  providerUsageSince,
  pruneProviderUsage,
  recordProviderRequest,
} from './usage';

const T0 = Date.parse('2026-01-05T10:00:30Z');
const MIN = 60_000;
const DAY = 86_400_000;

describe('provider usage', () => {
  it('counts each request at the end of its bucket, never earlier than sent', async () => {
    const db = await testDb();
    for (let k = 0; k < 3; k++) {
      await recordProviderRequest(db, { provider: 'p', at: T0 + k * 1000, symbol: 'AAA' });
    }
    await recordProviderRequest(db, { provider: 'p', at: T0 + MIN, symbol: null });
    await recordProviderRequest(db, { provider: 'other', at: T0, symbol: 'ZZZ' });
    const h = await providerUsageSince(db, 'p', T0 + 2 * MIN);
    const end = Date.parse('2026-01-05T10:00:59.999Z');
    expect(h.requests).toEqual([end, end, end, end + MIN]);
    for (const t of h.requests) expect(t).toBeGreaterThanOrEqual(T0);
    expect([...h.symbols]).toEqual([['AAA', Date.parse('2026-01-05T23:59:59.999Z')]]);
  });

  it('keeps each symbol once per day, across days', async () => {
    const db = await testDb();
    for (const s of ['AAA', 'BBB', 'AAA', 'CCC', 'BBB']) {
      await recordProviderRequest(db, { provider: 'p', at: T0, symbol: s });
    }
    await recordProviderRequest(db, { provider: 'p', at: T0 + DAY, symbol: 'AAA' });
    const days = await db.select().from(schema.providerUsage);
    const first = days.find((d) => d.windowType === 'day' && d.windowStart === '2026-01-05');
    expect(first).toMatchObject({ requestCount: 5, symbols: ['AAA', 'BBB', 'CCC'] });
    const h = await providerUsageSince(db, 'p', T0 + DAY);
    expect(h.symbols.get('AAA')).toBe(Date.parse('2026-01-06T23:59:59.999Z'));
    expect(h.symbols.get('BBB')).toBe(Date.parse('2026-01-05T23:59:59.999Z'));
  });

  it('reads only what a window can still count, and prunes the rest', async () => {
    // Rows after `now` (a clock set back) would be read too: counted, never dropped.
    const db = await testDb();
    await recordProviderRequest(db, { provider: 'p', at: T0, symbol: 'OLD' });
    // A day and a minute later: the first minute bucket ended more than a day ago.
    const now = T0 + DAY + MIN;
    expect((await providerUsageSince(db, 'p', now)).requests).toHaveLength(0);
    // The day bucket still counts its symbol until 31 days after the day's end.
    const dayEnd = Date.parse('2026-01-05T23:59:59.999Z');
    expect(
      (await providerUsageSince(db, 'p', dayEnd + USAGE_SYMBOL_WINDOW_MS)).symbols.has('OLD'),
    ).toBe(true);
    expect(await pruneProviderUsage(db, now)).toBe(1); // the old minute bucket only
    await recordProviderRequest(db, { provider: 'p', at: T0 + 40 * DAY, symbol: 'NEW' });
    expect(await pruneProviderUsage(db, dayEnd + USAGE_SYMBOL_WINDOW_MS + 1)).toBe(1);
    const left = await db.select().from(schema.providerUsage);
    expect(left.map((r) => r.windowStart).sort()).toEqual([
      '2026-02-14',
      '2026-02-14T10:00:00.000Z',
    ]);
  });

  it('stores no URL, key or body: only provider, bucket, count and symbols', async () => {
    const db = await testDb();
    await recordProviderRequest(db, { provider: 'p', at: T0, symbol: 'AAA' });
    const rows = await db.select().from(schema.providerUsage);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([
        'provider',
        'requestCount',
        'symbols',
        'windowStart',
        'windowType',
      ]);
    }
  });

  it('refuses a request time that is not a number', async () => {
    const db = await testDb();
    await expect(
      recordProviderRequest(db, { provider: 'p', at: Number.NaN, symbol: null }),
    ).rejects.toThrow(/invalid request time/);
  });
});

// The deposit rate series (requirements 05 `CASH_BASE`, 01 "Bank deposits"; CLAUDE.md: rates are
// read only through asOf): dated, append-only, unknown before its first entry.
import { describe, expect, it } from 'vitest';
import { addDepositRate, depositRateAsOf, depositRateEntries } from './deposit-rates';
import { depositRates } from './schema';
import { setSetting } from './settings';
import { testDb } from './testing';

// 2026-11-02 12:00 UTC is 2026-11-02 in New York.
const now = new Date('2026-11-02T12:00:00Z');
const entry = (ratePct: string, from: string, currency = 'XXX') => ({ ratePct, from, currency });

async function withBase() {
  const db = await testDb();
  await setSetting(db, 'base_currency', 'XXX');
  return db;
}

describe('deposit rates', () => {
  it('reads the entry in force on a date; unknown before the first (never a guess)', async () => {
    const db = await withBase();
    expect(await depositRateAsOf(db, '2026-11-02')).toEqual({ unknown: true });
    await addDepositRate(db, entry('0.1', '2026-01-05'), { now });
    await addDepositRate(db, entry('0.25', '2026-07-01'), { now });
    expect(await depositRateAsOf(db, '2026-01-04')).toEqual({ unknown: true });
    expect(await depositRateAsOf(db, '2026-01-05')).toEqual({ entry: entry('0.1', '2026-01-05') });
    expect(await depositRateAsOf(db, '2026-06-30')).toEqual({ entry: entry('0.1', '2026-01-05') });
    expect(await depositRateAsOf(db, '2026-07-01')).toEqual({ entry: entry('0.25', '2026-07-01') });
    expect(await depositRateAsOf(db, '2030-01-01')).toEqual({ entry: entry('0.25', '2026-07-01') });
    expect(await depositRateEntries(db)).toEqual([
      entry('0.1', '2026-01-05'),
      entry('0.25', '2026-07-01'),
    ]);
    await expect(depositRateAsOf(db, '2026-13-01')).rejects.toThrow(/Not a date/);
  });

  it('leaves out entries added after knownBy', async () => {
    const db = await withBase();
    await addDepositRate(db, entry('0.1', '2026-01-05'), { now });
    expect(await depositRateAsOf(db, '2026-02-01', { knownBy: new Date('2000-01-01') })).toEqual({
      unknown: true,
    });
    expect(await depositRateAsOf(db, '2026-02-01', { knownBy: new Date('2100-01-01') })).toEqual({
      entry: entry('0.1', '2026-01-05'),
    });
  });

  it('never edits or slips an entry before a later one', async () => {
    const db = await withBase();
    await addDepositRate(db, entry('0.1', '2026-03-02'), { now });
    for (const from of ['2026-03-02', '2026-01-05']) {
      await expect(addDepositRate(db, entry('0.2', from), { now })).rejects.toThrow(
        /after the latest entry's \(2026-03-02\)/,
      );
    }
    // The database refuses it too (triggers), and refuses edits and removals.
    const row = { ratePct: '0.2', currency: 'XXX', actor: 't' };
    await expect(
      db.insert(depositRates).values({ ...row, fromDate: '2026-02-01' }),
    ).rejects.toThrow();
    await expect(db.update(depositRates).set({ ratePct: '9' })).rejects.toThrow();
    await expect(db.delete(depositRates)).rejects.toThrow();
    expect(await depositRateEntries(db)).toEqual([entry('0.1', '2026-03-02')]);
  });

  it.each([
    [
      'a rate as a number-like text with a sign',
      entry('-0.1', '2026-01-05'),
      /the rate must be a decimal/,
    ],
    ['a rate with an exponent', entry('1e-1', '2026-01-05'), /the rate must be a decimal/],
    ['a rate of 1000%', entry('1000', '2026-01-05'), /the rate must be below 1000/],
    ['16 significant digits', entry('0.1234567890123456', '2026-01-05'), /15 significant digits/],
    ['a date that does not exist', entry('0.1', '2026-02-30'), /start date must be a date/],
    [
      'a date after today in New York',
      entry('0.1', '2026-11-03'),
      /2026-11-03 is after today \(2026-11-02, New York\)/,
    ],
    [
      'another currency than the base',
      entry('0.1', '2026-01-05', 'YYY'),
      /base currency XXX \(got YYY\)/,
    ],
  ])('refuses %s', async (_, e, reason) => {
    const db = await withBase();
    await expect(addDepositRate(db, e, { now })).rejects.toThrow(reason);
    expect(await depositRateEntries(db)).toEqual([]);
  });

  it("uses New York's date for today, not UTC's", async () => {
    const db = await withBase();
    // 2026-11-03 02:00 UTC is still 2026-11-02 in New York.
    const late = new Date('2026-11-03T02:00:00Z');
    await expect(addDepositRate(db, entry('0.1', '2026-11-03'), { now: late })).rejects.toThrow(
      /after today \(2026-11-02, New York\)/,
    );
    await addDepositRate(db, entry('0.1', '2026-11-02'), { now: late });
  });

  it('refuses before the base currency is set', async () => {
    const db = await testDb();
    await expect(addDepositRate(db, entry('0.1', '2026-01-05'), { now })).rejects.toThrow(
      /base_currency is not set/,
    );
  });

  it('reports an entry written around the rules (a direct write) as invalid, never using it', async () => {
    const db = await withBase();
    await db
      .insert(depositRates)
      .values({ ratePct: '0,5', fromDate: '2026-01-05', currency: 'XXX', actor: 't' });
    expect(await depositRateAsOf(db, '2026-02-01')).toEqual({
      invalid: [expect.stringMatching(/^the rate must be a decimal/)],
    });
  });
});

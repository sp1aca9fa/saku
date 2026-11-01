// The deposit rate series (requirements 05 `CASH_BASE`, 01 "Bank deposits"; CLAUDE.md: rates are
// read only through asOf): dated, append-only, unknown before its first entry.
import { describe, expect, it } from 'vitest';
import {
  addDepositRate,
  correctDepositRate,
  depositRateAsOf,
  depositRateEntries,
  depositRateReader,
} from './deposit-rates';
import { depositRateRevisions, depositRates } from './schema';
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
      { ...entry('0.1', '2026-01-05'), enteredRatePct: '0.1', revisions: [] },
      { ...entry('0.25', '2026-07-01'), enteredRatePct: '0.25', revisions: [] },
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

  it('backfills before the earliest entry; refuses one on or between existing dates', async () => {
    const db = await withBase();
    await addDepositRate(db, entry('0.1', '2026-03-02'), { now });
    await addDepositRate(db, entry('0.3', '2026-09-01'), { now });
    for (const from of ['2026-03-02', '2026-05-01', '2026-09-01']) {
      await expect(addDepositRate(db, entry('0.2', from), { now })).rejects.toThrow(
        /after the latest entry's \(2026-09-01\) or before the earliest \(2026-03-02\)/,
      );
    }
    // Before the earliest: every reader saw unknown there.
    expect(await depositRateAsOf(db, '2026-01-10')).toEqual({ unknown: true });
    await addDepositRate(db, entry('0.05', '2026-01-05'), { now });
    expect(await depositRateAsOf(db, '2026-01-10')).toEqual({ entry: entry('0.05', '2026-01-05') });
    expect(await depositRateAsOf(db, '2026-03-02')).toEqual({ entry: entry('0.1', '2026-03-02') });
    // The database refuses one between too (triggers), and refuses edits and removals.
    const row = { ratePct: '0.2', currency: 'XXX', actor: 't' };
    await expect(
      db.insert(depositRates).values({ ...row, fromDate: '2026-02-01' }),
    ).rejects.toThrow();
    await expect(
      db.insert(depositRates).values({ ...row, fromDate: '2026-09-01' }),
    ).rejects.toThrow();
    await db.insert(depositRates).values({ ...row, fromDate: '2025-12-01' });
    await expect(db.update(depositRates).set({ ratePct: '9' })).rejects.toThrow();
    await expect(db.delete(depositRates)).rejects.toThrow();
    expect((await depositRateEntries(db)).map((e) => e.from)).toEqual([
      '2025-12-01',
      '2026-01-05',
      '2026-03-02',
      '2026-09-01',
    ]);
  });

  it('corrects a rate with a revision row; knownBy reads it only from when it was made', async () => {
    const db = await withBase();
    await addDepositRate(db, entry('0.1', '2026-03-02'), { now });
    const before = new Date();
    // The correction is made after `before` (the clock moves on): known by a later instant only.
    await new Promise((r) => setTimeout(r, 10));
    expect(
      await correctDepositRate(db, { from: '2026-03-02', ratePct: '0.15', reason: 'typo' }),
    ).toEqual({ oldRatePct: '0.1' });
    const after = new Date();
    expect(await depositRateAsOf(db, '2026-04-01')).toEqual({ entry: entry('0.15', '2026-03-02') });
    expect(await depositRateAsOf(db, '2026-04-01', { knownBy: before })).toEqual({
      entry: entry('0.1', '2026-03-02'),
    });
    expect(await depositRateAsOf(db, '2026-04-01', { knownBy: after })).toEqual({
      entry: entry('0.15', '2026-03-02'),
    });
    // A second correction replaces the one in force; the listing keeps the whole chain.
    await correctDepositRate(db, { from: '2026-03-02', ratePct: '0.12', reason: 'bank letter' });
    const [listed] = await depositRateEntries(db);
    expect(listed).toMatchObject({
      ratePct: '0.12',
      enteredRatePct: '0.1',
      revisions: [
        { oldRatePct: '0.1', newRatePct: '0.15', reason: 'typo', actor: 'cli' },
        { oldRatePct: '0.15', newRatePct: '0.12', reason: 'bank letter', actor: 'cli' },
      ],
    });
  });

  it('refuses a correction without an entry, a reason, a valid new rate or a change', async () => {
    const db = await withBase();
    await addDepositRate(db, entry('0.1', '2026-03-02'), { now });
    const bad = (c: { from: string; ratePct: string; reason: string }) =>
      expect(correctDepositRate(db, c)).rejects;
    await bad({ from: '2026-03-03', ratePct: '0.2', reason: 'x' }).toThrow(/no entry starts on/);
    await bad({ from: '2026-03-02', ratePct: '0.2', reason: '  ' }).toThrow(/states its reason/);
    await bad({ from: '2026-03-02', ratePct: '-1', reason: 'x' }).toThrow(
      /the rate must be a decimal/,
    );
    await bad({ from: '2026-03-02', ratePct: '0.10', reason: 'x' }).toThrow(/already 0.1/);
    expect((await depositRateEntries(db))[0]!.revisions).toEqual([]);
    // The database refuses a revision that does not replace the rate in force, or has no
    // reason, and refuses edits and removals of revisions.
    const id = (await db.select().from(depositRates))[0]!.id;
    const rev = { entryId: id, newRatePct: '0.2', actor: 't' };
    await expect(
      db.insert(depositRateRevisions).values({ ...rev, oldRatePct: '0.3', reason: 'x' }),
    ).rejects.toThrow();
    await expect(
      db.insert(depositRateRevisions).values({ ...rev, oldRatePct: '0.1', reason: ' ' }),
    ).rejects.toThrow();
    await db.insert(depositRateRevisions).values({ ...rev, oldRatePct: '0.1', reason: 'x' });
    await expect(db.update(depositRateRevisions).set({ reason: 'y' })).rejects.toThrow();
    await expect(db.delete(depositRateRevisions)).rejects.toThrow();
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
    expect((await depositRateReader(db))('2026-02-01')).toEqual(
      await depositRateAsOf(db, '2026-02-01'),
    );
  });

  it('the in-memory reader answers every date as depositRateAsOf does', async () => {
    const db = await withBase();
    expect((await depositRateReader(db))('2026-01-05')).toEqual({ unknown: true });
    await addDepositRate(db, entry('0.1', '2026-01-05'), { now });
    await addDepositRate(db, entry('0.25', '2026-07-01'), { now });
    const beforeBackfill = new Date();
    await new Promise((r) => setTimeout(r, 5));
    await addDepositRate(db, entry('0.05', '2025-06-02'), { now });
    await correctDepositRate(db, { from: '2026-01-05', ratePct: '0.15', reason: 'typo' });
    await new Promise((r) => setTimeout(r, 5));
    const between = new Date();
    await new Promise((r) => setTimeout(r, 5));
    await correctDepositRate(db, { from: '2026-01-05', ratePct: '0.12', reason: 'bank letter' });
    const read = await depositRateReader(db);
    // Point in time: the same answer as depositRateAsOf with the same knownBy.
    for (const knownBy of [new Date('2000-01-01T00:00:00Z'), beforeBackfill, between, new Date()]) {
      for (const d of ['2025-06-02', '2026-01-05', '2026-07-01']) {
        expect(read(d, { knownBy: knownBy.toISOString() })).toEqual(
          await depositRateAsOf(db, d, { knownBy }),
        );
      }
    }
    expect(read('2025-06-02', { knownBy: beforeBackfill.toISOString() })).toEqual({
      unknown: true,
    });
    expect(read('2026-03-02', { knownBy: between.toISOString() })).toEqual({
      entry: entry('0.15', '2026-01-05'),
    });
    for (const d of [
      '2025-06-01',
      '2025-06-02',
      '2026-01-04',
      '2026-01-05',
      '2026-06-30',
      '2026-07-01',
      '2030-01-01',
    ]) {
      expect(read(d)).toEqual(await depositRateAsOf(db, d));
    }
    expect(read('2026-03-02')).toEqual({ entry: entry('0.12', '2026-01-05') });
    expect(() => read('2026-13-01')).toThrow(/Not a date/);
  });
});

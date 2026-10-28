import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { forwardEntries, strategyVersions } from './schema';
import {
  addJournalEntry,
  appendForward,
  forwardRecord,
  journalOf,
  registerVersion,
  sha256,
  verifyChain,
  visibleVersion,
  visibleVersions,
} from './strategies';
import { testDb } from './testing';
import { createUser } from './users';

const user = (username: string) => ({
  username,
  passwordHash: 'scrypt:x',
  totpSecretEnc: 'v1.x',
  totpLastStep: 100,
  backupCodeHashes: ['a'],
  isAdmin: false,
});

const entry = (date: string, allocation = 'Risk on') => ({
  date,
  allocation,
  holdings: [{ ticker: 'UPRO', weight: 100 }],
  safeStateApplied: false,
  dataStatus: 'green' as const,
  equity: 1,
  detail: { signals: { A: 1 }, execution: 'next_open' },
});

async function setup() {
  const db = await testDb();
  const alice = await createUser(db, user('alice'));
  const bob = await createUser(db, user('bob'));
  const version = await registerVersion(db, {
    ownerId: alice,
    name: 'Setup',
    strategy: { name: 'Setup', allocations: [] },
    at: new Date('2026-02-02T00:00:00Z'),
  });
  return { db, alice, bob, version };
}

describe('forward record', () => {
  it('chains each entry to the previous hash, over the stored canonical text', async () => {
    const { db, version } = await setup();
    expect(version.hash).toBe(sha256(version.canonicalJson));
    const a = await appendForward(db, version, entry('2026-02-02'), null);
    const b = await appendForward(db, version, entry('2026-02-03', 'Cash'), null);
    expect(a.prevHash).toBe(version.hash);
    expect(b.prevHash).toBe(a.hash);
    expect(b.hash).toBe(sha256(b.payload));
    expect(JSON.parse(b.payload)).toMatchObject({ allocation: 'Cash', prevHash: a.hash });
    expect(await verifyChain(db, version)).toEqual([]);
  });

  it('only grows: no earlier or repeated date, no updates or deletes', async () => {
    const { db, version } = await setup();
    await appendForward(db, version, entry('2026-02-03'), null);
    await expect(appendForward(db, version, entry('2026-02-03'), null)).rejects.toThrow(
      /only grows/,
    );
    await expect(appendForward(db, version, entry('2026-02-02'), null)).rejects.toThrow(
      /only grows/,
    );
    await expect(db.update(forwardEntries).set({ allocation: 'Cash' })).rejects.toThrow();
    await expect(db.delete(forwardEntries)).rejects.toThrow();
    await expect(db.update(strategyVersions).set({ name: 'x' })).rejects.toThrow();
    expect(await forwardRecord(db, version.id)).toHaveLength(1);
  });

  it('finds a changed text or a broken link', async () => {
    const { db, version } = await setup();
    await appendForward(db, version, entry('2026-02-02'), null);
    await appendForward(db, version, entry('2026-02-03'), null);
    // Simulate tampering below the app (the triggers stop it through SQL).
    await db.run(sql`DROP TRIGGER forward_entries_no_update`);
    await db.run(
      sql`UPDATE forward_entries SET payload = replace(payload, 'Risk on', 'Cash') WHERE date = '2026-02-02'`,
    );
    const problems = await verifyChain(db, version);
    expect(problems).toContain('2026-02-02: hash');
    expect(problems).toContain('2026-02-02: columns differ from the hashed text');
  });
});

describe('who sees what', () => {
  it('a user sees their own versions and the library, not another user’s', async () => {
    const { db, bob, version } = await setup();
    const library = await registerVersion(db, {
      ownerId: null,
      name: 'Buy and hold',
      strategy: {},
    });
    expect((await visibleVersions(db, bob)).map((v) => v.id)).toEqual([library.id]);
    expect(await visibleVersion(db, bob, version.id)).toBeUndefined();
  });

  it('journal entries only on a version the user may read, and only their own are listed', async () => {
    const { db, alice, bob, version } = await setup();
    await addJournalEntry(db, alice, {
      versionId: version.id,
      signalDate: '2026-02-02',
      action: 'done',
    });
    await expect(
      addJournalEntry(db, bob, { versionId: version.id, signalDate: '2026-02-02', action: 'done' }),
    ).rejects.toThrow(/No such strategy version/);
    expect(await journalOf(db, alice, version.id)).toHaveLength(1);
    expect(await journalOf(db, bob, version.id)).toEqual([]);
  });
});

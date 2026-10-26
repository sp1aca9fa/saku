import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { activityLog, backupCodes } from './schema';
import { testDb } from './testing';
import { createUser, getUserByUsername, listUsers } from './users';

const input = {
  username: 'alex',
  passwordHash: 'scrypt:x',
  totpSecretEnc: 'v1.x',
  totpLastStep: 100,
  backupCodeHashes: ['a', 'b'],
  isAdmin: true,
};

describe('users', () => {
  it('creates an account with its backup codes and logs it', async () => {
    const db = await testDb();
    const id = await createUser(db, input);
    expect((await getUserByUsername(db, 'alex'))?.id).toBe(id);
    expect(await db.select().from(backupCodes).where(eq(backupCodes.userId, id))).toHaveLength(2);
    const [log] = await db.select().from(activityLog);
    expect(log).toMatchObject({ actor: 'cli', action: 'user.create' });
    expect(await listUsers(db)).toMatchObject([{ username: 'alex', isAdmin: true }]);
  });

  it('writes nothing when the username is taken', async () => {
    const db = await testDb();
    await createUser(db, input);
    await expect(createUser(db, { ...input, backupCodeHashes: ['c'] })).rejects.toThrow();
    expect(await db.select().from(backupCodes)).toHaveLength(2);
    expect(await db.select().from(activityLog)).toHaveLength(1);
  });
});

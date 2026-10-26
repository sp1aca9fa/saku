import { asc, eq } from 'drizzle-orm';
import type { Db } from './client';
import { activityLog, backupCodes, users } from './schema';

export interface NewUser {
  username: string;
  passwordHash: string;
  totpSecretEnc: string;
  /** The last TOTP step used during setup, so that code cannot be used again to sign in. */
  totpLastStep: number;
  backupCodeHashes: string[];
  isAdmin: boolean;
}

export async function getUserByUsername(db: Db, username: string) {
  const [user] = await db.select().from(users).where(eq(users.username, username));
  return user;
}

/** Creates a set-up account with its backup codes, logged as an admin task. */
export async function createUser(db: Db, input: NewUser, actor = 'cli'): Promise<string> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        username: input.username,
        passwordHash: input.passwordHash,
        totpSecretEnc: input.totpSecretEnc,
        totpLastStep: input.totpLastStep,
        isAdmin: input.isAdmin,
      })
      .returning({ id: users.id });
    await tx
      .insert(backupCodes)
      .values(input.backupCodeHashes.map((codeHash) => ({ userId: user!.id, codeHash })));
    await tx.insert(activityLog).values({
      actor,
      action: 'user.create',
      detail: { userId: user!.id, username: input.username, isAdmin: input.isAdmin },
    });
    return user!.id;
  });
}

export async function listUsers(db: Db) {
  return db
    .select({
      username: users.username,
      isAdmin: users.isAdmin,
      disabledAt: users.disabledAt,
      setUp: users.totpSecretEnc,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(asc(users.username));
}

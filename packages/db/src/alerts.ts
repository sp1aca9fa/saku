// Alert channels and delivered alerts (requirements 11). Targets are stored encrypted; every
// query is scoped to the channel's owner. Delivery is idempotent per (channel, subject, date,
// type), where the subject is a strategy version or a job type.
import { decryptSecret, encryptSecret } from '@saku/auth';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from './client';
import { activityLog, alertsSent, notificationChannels, users } from './schema';

const PURPOSE = 'alert-target';

export interface Channel {
  id: string;
  ownerId: string;
  type: string;
  admin: boolean;
  enabled: boolean;
}

export async function addChannel(
  db: Db,
  ownerId: string,
  o: { type: string; target: string; admin?: boolean; authSecret: string },
): Promise<string> {
  if (o.admin) {
    const [user] = await db.select().from(users).where(eq(users.id, ownerId));
    if (!user?.isAdmin) throw new Error('Only admins receive operational alerts.');
  }
  const [row] = await db
    .insert(notificationChannels)
    .values({
      ownerId,
      type: o.type,
      targetEnc: encryptSecret(o.target, o.authSecret, PURPOSE),
      admin: o.admin ?? false,
    })
    .returning({ id: notificationChannels.id });
  await db.insert(activityLog).values({
    actor: ownerId,
    action: 'channel.add',
    detail: { id: row!.id, type: o.type, admin: o.admin ?? false },
  });
  return row!.id;
}

const columns = {
  id: notificationChannels.id,
  ownerId: notificationChannels.ownerId,
  type: notificationChannels.type,
  admin: notificationChannels.admin,
  enabled: notificationChannels.enabled,
};

export async function channelsOf(db: Db, ownerId: string): Promise<Channel[]> {
  return db
    .select(columns)
    .from(notificationChannels)
    .where(eq(notificationChannels.ownerId, ownerId));
}

/** Turns a channel on or off (channels are kept: delivered alerts refer to them). */
export async function setChannelEnabled(db: Db, ownerId: string, id: string, enabled: boolean) {
  const changed = await db
    .update(notificationChannels)
    .set({ enabled })
    .where(and(eq(notificationChannels.id, id), eq(notificationChannels.ownerId, ownerId)))
    .returning({ id: notificationChannels.id });
  if (changed.length === 0) throw new Error('No such channel.');
  await db.insert(activityLog).values({
    actor: ownerId,
    action: enabled ? 'channel.enable' : 'channel.disable',
    detail: { id },
  });
}

/**
 * The owner's enabled channels with their decrypted targets (jobs only, never shown). A target
 * that does not decrypt (AUTH_SECRET missing or changed) is null, so the other channels still go.
 */
export async function deliveryTargets(
  db: Db,
  ownerId: string,
  authSecret: string,
): Promise<(Channel & { target: string | null })[]> {
  const rows = await db
    .select()
    .from(notificationChannels)
    .where(and(eq(notificationChannels.ownerId, ownerId), eq(notificationChannels.enabled, true)));
  return rows.map((r) => ({
    id: r.id,
    ownerId: r.ownerId,
    type: r.type,
    admin: r.admin,
    enabled: r.enabled,
    target: decrypt(r.targetEnc, authSecret),
  }));
}

function decrypt(payload: string, authSecret: string): string | null {
  try {
    return authSecret ? decryptSecret(payload, authSecret, PURPOSE) : null;
  } catch {
    return null;
  }
}

export interface AlertKey {
  subject: string;
  date: string;
  type: string;
}

export async function alertSent(db: Db, channel: Channel, key: AlertKey): Promise<boolean> {
  const [row] = await db
    .select({ id: alertsSent.id })
    .from(alertsSent)
    .where(
      and(
        eq(alertsSent.ownerId, channel.ownerId),
        eq(alertsSent.channelId, channel.id),
        eq(alertsSent.subject, key.subject),
        eq(alertsSent.date, key.date),
        eq(alertsSent.type, key.type),
      ),
    );
  return row !== undefined;
}

export async function recordAlertSent(
  db: Db,
  channel: Channel,
  key: AlertKey,
  allocation?: string,
): Promise<void> {
  await db
    .insert(alertsSent)
    .values({ ownerId: channel.ownerId, channelId: channel.id, ...key, allocation })
    .onConflictDoNothing();
}

/** The allocation the channel was last told for a subject, among alerts of the given types. */
export async function lastToldAllocation(
  db: Db,
  channel: Channel,
  subject: string,
  types: string[],
): Promise<string | undefined> {
  const [row] = await db
    .select({ allocation: alertsSent.allocation })
    .from(alertsSent)
    .where(
      and(
        eq(alertsSent.ownerId, channel.ownerId),
        eq(alertsSent.channelId, channel.id),
        eq(alertsSent.subject, subject),
        inArray(alertsSent.type, types),
      ),
    )
    .orderBy(desc(alertsSent.id))
    .limit(1);
  return row?.allocation ?? undefined;
}

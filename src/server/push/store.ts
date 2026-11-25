import { eq } from 'drizzle-orm'

import type { PushDevice, PushSubscribeBody } from '../../shared/push'
import type { Database } from '../db'
import { pushSent, pushSubscription } from '../db/schema'

export type StoredSubscription = typeof pushSubscription.$inferSelect

/** A short label from the user agent: the browser and the system, enough to tell the devices apart. */
export function labelFromUserAgent(ua: string | undefined): string {
  if (!ua) return 'Unknown device'
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser'
  const system = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : ''
  return system ? `${browser} on ${system}` : browser
}

/** One row per endpoint: subscribing again replaces the keys and the label. */
export async function saveSubscription(
  db: Database,
  body: PushSubscribeBody,
  userAgent: string | undefined,
): Promise<StoredSubscription> {
  const values = {
    endpoint: body.endpoint,
    p256dh: body.keys.p256dh,
    auth: body.keys.auth,
    label: labelFromUserAgent(userAgent),
  }
  const [row] = await db
    .insert(pushSubscription)
    .values(values)
    .onConflictDoUpdate({
      target: pushSubscription.endpoint,
      set: { p256dh: values.p256dh, auth: values.auth, label: values.label },
    })
    .returning()
  return row
}

export const removeSubscription = (db: Database, endpoint: string) =>
  db.delete(pushSubscription).where(eq(pushSubscription.endpoint, endpoint))

export const removeSubscriptionById = (db: Database, id: number) =>
  db.delete(pushSubscription).where(eq(pushSubscription.id, id))

export const listSubscriptions = (db: Database) =>
  db.select().from(pushSubscription).orderBy(pushSubscription.id)

export async function listDevices(db: Database): Promise<PushDevice[]> {
  return (await listSubscriptions(db)).map((s) => ({
    id: s.id,
    label: s.label,
    createdAt: s.createdAt.toISOString(),
    lastSuccessAt: s.lastSuccessAt?.toISOString() ?? null,
  }))
}

export const deliveredTo = (db: Database, subscriptionId: number) =>
  db
    .select({ identity: pushSent.identity, at: pushSent.itemAt })
    .from(pushSent)
    .where(eq(pushSent.subscriptionId, subscriptionId))
    .then((rows) => rows.map((r) => ({ identity: r.identity, at: r.at.toISOString() })))

export async function recordDelivery(
  db: Database,
  subscriptionId: number,
  identity: string,
  at: string,
): Promise<void> {
  await db
    .insert(pushSent)
    .values({ identity, itemAt: new Date(at), subscriptionId })
    .onConflictDoNothing()
  await db
    .update(pushSubscription)
    .set({ lastSuccessAt: new Date() })
    .where(eq(pushSubscription.id, subscriptionId))
}

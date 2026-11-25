import type { Pool } from 'pg'

import type { Database } from '../db'
import { inbox } from '../panel/queries'

import type { PushConfig } from './config'
import { departed, newMessages } from './notify'
import type { PushSender } from './send'
import { isGone } from './send'
import {
  deliveredTo,
  forgetDelivered,
  listSubscriptions,
  recordDelivery,
  removeSubscriptionById,
} from './store'

const PUSH_LOCK = 'push-attention'

export type PushPassDeps = {
  db: Database
  pool: Pick<Pool, 'connect'>
  config: PushConfig | null
  sender: PushSender
  log?: (line: Record<string, unknown>) => void
}

export type PushPassResult = { sent: number; removed: number; failed: number }

/**
 * One pass: every new inbox item goes once to every device. An item is the same while its identity stays in the
 * inbox, whatever new events its task gets; one that left and came back is sent again. A gone endpoint is deleted; any other failure is logged and tried again next pass.
 * One pass runs at a time on any process (an advisory lock), so two never send the same message.
 */
export async function pushPass(deps: PushPassDeps): Promise<PushPassResult | undefined> {
  const { db, config, sender } = deps
  const log = deps.log ?? ((line) => console.log(JSON.stringify(line)))
  const result: PushPassResult = { sent: 0, removed: 0, failed: 0 }
  if (!config) return result
  const client = await deps.pool.connect()
  try {
    const taken = await client.query<{ taken: boolean }>(
      'select pg_try_advisory_lock(hashtext($1)) as taken',
      [PUSH_LOCK],
    )
    if (!taken.rows[0]?.taken) return undefined
    try {
      const subscriptions = await listSubscriptions(db)
      if (subscriptions.length === 0) return result
      const items = await inbox(db)
      for (const sub of subscriptions) {
        const delivered = await deliveredTo(db, sub.id)
        await forgetDelivered(db, sub.id, departed(items, delivered))
        const messages = newMessages(items, delivered, config.origin)
        for (const message of messages) {
          const outcome = await sender(sub, message.payload)
          if (outcome.ok) {
            await recordDelivery(db, sub.id, message.identity, message.at)
            result.sent++
          } else if (isGone(outcome)) {
            await removeSubscriptionById(db, sub.id)
            result.removed++
            break
          } else {
            result.failed++
            log({
              event: 'push_failed',
              subscription: sub.id,
              status: outcome.status ?? null,
              reason: outcome.reason,
            })
          }
        }
      }
      return result
    } finally {
      await client.query('select pg_advisory_unlock(hashtext($1))', [PUSH_LOCK])
    }
  } finally {
    client.release()
  }
}

const NOT_CONFIGURED = { configured: false } as const

/** A test message to every device, now. A gone endpoint is deleted, as in a pass. */
export async function sendTest(
  deps: Pick<PushPassDeps, 'db' | 'config' | 'sender'>,
): Promise<{ configured: boolean; sent: number; failed: number; removed: number }> {
  const { db, config, sender } = deps
  if (!config) return { ...NOT_CONFIGURED, sent: 0, failed: 0, removed: 0 }
  const out = { configured: true, sent: 0, failed: 0, removed: 0 }
  for (const sub of await listSubscriptions(db)) {
    const outcome = await sender(sub, {
      title: 'aifactory',
      body: 'Notifications are on for this device.',
      url: config.origin,
      tag: 'push-test',
    })
    if (outcome.ok) out.sent++
    else if (isGone(outcome)) {
      await removeSubscriptionById(db, sub.id)
      out.removed++
    } else out.failed++
  }
  return out
}

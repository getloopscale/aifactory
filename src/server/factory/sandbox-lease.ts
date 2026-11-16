import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import { getDb } from '../db'
import type { Database } from '../db'
import { sandboxLease } from '../db/schema'

import type { IsolatedSandboxProvider } from './sandbox'

/** Names this process in the metadata of every sandbox it creates. */
export const PROCESS_LEASE = randomUUID()

/** How often a live process says so. */
export const LEASE_BEAT_MS = 10_000

/** A lease not renewed for this long belongs to a process that is gone: four beats missed (a process killed is seen on the next supervise pass). */
export const LEASE_STALE_MS = 45_000

let failedAt: number | undefined

/** Says this process is alive. A failure is remembered: while the database was out, no process could renew. */
export async function beat(db: Database): Promise<void> {
  const beatAt = new Date()
  try {
    await db
      .insert(sandboxLease)
      .values({ id: PROCESS_LEASE, host: hostname(), beatAt })
      .onConflictDoUpdate({ target: sandboxLease.id, set: { beatAt } })
  } catch (error) {
    failedAt = Date.now()
    throw error
  }
}

/** Whether a stale lease means a dead process: not while this process could not renew its own lately. */
export function leasesTrustworthy(now: number = Date.now()): boolean {
  return failedAt === undefined || now - failedAt > LEASE_STALE_MS + LEASE_BEAT_MS
}

let beating: ReturnType<typeof setInterval> | undefined

/**
 * Says this process is alive, now and every half minute while it runs. Awaited before a sandbox is created, so
 * the supervisor never sees a sandbox whose lease it cannot find.
 */
export async function holdLease(db: Database = getDb()): Promise<void> {
  await beat(db)
  beating ??= setInterval(() => {
    beat(db).catch((error) =>
      console.error(JSON.stringify({ event: 'sandbox_lease_failed', error: String(error) })),
    )
  }, LEASE_BEAT_MS)
  beating.unref()
}

/** The provider, with the lease held before it creates or restores a sandbox. */
export function withLease<T extends IsolatedSandboxProvider>(
  provider: T,
  hold: () => Promise<void> = holdLease,
): T {
  return new Proxy(provider, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if ((key === 'create' || key === 'restore') && typeof value === 'function') {
        return async (...args: unknown[]) => {
          await hold()
          return value.apply(target, args)
        }
      }
      return value
    },
  })
}

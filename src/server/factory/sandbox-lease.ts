import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import { getDb } from '../db'
import type { Database } from '../db'
import { sandboxLease } from '../db/schema'

import type { IsolatedSandboxProvider } from './sandbox'

/** Names this process in the metadata of every sandbox it creates. */
export const PROCESS_LEASE = randomUUID()

/** How often a live process says so. */
export const LEASE_BEAT_MS = 30_000

/** A lease not renewed for this long belongs to a process that is gone: four beats missed. */
export const LEASE_STALE_MS = 2 * 60_000

async function beat(db: Database): Promise<void> {
  const beatAt = new Date()
  await db
    .insert(sandboxLease)
    .values({ id: PROCESS_LEASE, host: hostname(), beatAt })
    .onConflictDoUpdate({ target: sandboxLease.id, set: { beatAt } })
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

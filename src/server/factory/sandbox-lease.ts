import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'

import { getDb } from '../db'
import type { Database } from '../db'
import { sandboxLease } from '../db/schema'

import type { IsolatedSandboxProvider } from './sandbox'

/** How often a live process says so. */
export const LEASE_BEAT_MS = 30_000

export { LEASE_STALE_MS } from './sandbox-reaper'

/**
 * A process that creates sandboxes, as its lease records it: the host and the process id let the supervisor on
 * the same host ask the system whether it still runs, and `started` tells it from a later process that reused
 * the id. `started` is null where the system does not say (no `/proc`).
 */
export type ProcessIdentity = { lease: string; host: string; pid: number; started: string | null }

/** When a process started, in clock ticks since boot (`/proc/<pid>/stat`), or null when that cannot be read. */
export function processStart(pid: number, read = readFileSync): string | null {
  try {
    const stat = read(`/proc/${pid}/stat`, 'utf8')
    // The command name, in parentheses, may hold spaces: the fields after it start at the third.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null
  } catch {
    // No such process, or a system without /proc: the caller tells which.
    return null
  }
}

/** The identity of a process on this host, under the lease it holds. */
export function identityOf(pid: number, lease: string): ProcessIdentity {
  return { lease, host: hostname(), pid, started: processStart(pid) }
}

/** This process, named in the metadata of every sandbox it creates. */
export const THIS_PROCESS: ProcessIdentity = identityOf(process.pid, randomUUID())

/**
 * Says the process is alive. A beat clears a suspicion the supervisor recorded, so a process that comes back
 * after an outage keeps its sandboxes.
 */
export async function beat(
  db: Database,
  identity: ProcessIdentity,
  beatAt: Date = new Date(),
): Promise<void> {
  const { lease: id, host, pid, started } = identity
  await db
    .insert(sandboxLease)
    .values({ id, host, pid, started, beatAt })
    .onConflictDoUpdate({ target: sandboxLease.id, set: { beatAt, staleSeenAt: null } })
}

let beating: ReturnType<typeof setInterval> | undefined

/**
 * Says this process is alive, now and every half minute while it runs. Awaited before a sandbox is created, so
 * the supervisor never sees a sandbox whose lease it cannot find.
 */
export async function holdLease(db: Database = getDb()): Promise<void> {
  await beat(db, THIS_PROCESS)
  beating ??= setInterval(() => {
    beat(db, THIS_PROCESS).catch((error) =>
      console.error(
        JSON.stringify({
          event: 'sandbox_lease_failed',
          lease: THIS_PROCESS.lease,
          error: String(error),
        }),
      ),
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

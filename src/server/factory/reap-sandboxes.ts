// The one module that acts on what `reapable` decides: it stops sandboxes and records suspicions on leases.
import { and, eq, isNull, lt } from 'drizzle-orm'

import type { Database } from '../db'
import { sandboxLease } from '../db/schema'

import type { ListedSandbox } from './sandbox'
import { reapable, type Kill } from './sandbox-reaper'
import { readReaperFacts } from './sandbox-reaper-facts'

/** A lease of a process quiet for a day names no sandbox that can still be up: E2B ends a session in an hour. */
const LEASE_KEPT_MS = 24 * 60 * 60_000

export type ReaperDeps = {
  db: Database
  listSandboxes: () => Promise<ListedSandbox[]>
  killSandbox: (id: string) => Promise<void>
  now?: () => Date
}

/** Stops every sandbox whose owner is done and logs each with its id and why. */
export async function reapSandboxes(deps: ReaperDeps): Promise<Kill[]> {
  const listing = await deps.listSandboxes()
  const facts = await readReaperFacts(deps.db, listing, deps.now?.())
  const plan = reapable(listing, facts)
  const killed: Kill[] = []
  for (const verdict of plan.kill) {
    try {
      await deps.killSandbox(verdict.id)
      killed.push(verdict)
      console.log(
        JSON.stringify({ event: 'sandbox_reaped', sandbox: verdict.id, reason: verdict.reason }),
      )
    } catch (error) {
      // One sandbox that will not stop leaves the others to stop; the next pass tries it again.
      console.error(
        JSON.stringify({
          event: 'sandbox_reap_failed',
          sandbox: verdict.id,
          reason: verdict.reason,
          error: String(error),
        }),
      )
    }
  }
  for (const s of plan.suspect) {
    // Only on the beat the pass saw: a process that beat since then is not suspected.
    await deps.db
      .update(sandboxLease)
      .set({ staleSeenAt: facts.now })
      .where(
        and(
          eq(sandboxLease.id, s.lease),
          eq(sandboxLease.beatAt, s.beatAt),
          isNull(sandboxLease.staleSeenAt),
        ),
      )
  }
  await deps.db
    .delete(sandboxLease)
    .where(lt(sandboxLease.beatAt, new Date(facts.now.getTime() - LEASE_KEPT_MS)))
  return killed
}

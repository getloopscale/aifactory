import { sql } from 'drizzle-orm'

import type { Database } from '../db'
import { FACTORY_APP } from '../factory/sandbox-reaper'
import type { ListedSandbox } from '../factory/sandbox'

/** How many code workspaces may be up at once, unless `FACTORY_CODE_MAX_SANDBOXES` says another number. */
export const DEFAULT_CODE_MAX_SANDBOXES = 2

export function codeMaxSandboxes(env: NodeJS.ProcessEnv = process.env): number {
  const set = Number(env.FACTORY_CODE_MAX_SANDBOXES)
  return Number.isInteger(set) && set > 0 ? set : DEFAULT_CODE_MAX_SANDBOXES
}

/** Whether a listed sandbox is a code workspace of the factory. */
export const isCodeWorkspace = (s: ListedSandbox): boolean =>
  s.metadata.app === FACTORY_APP && s.metadata.owner === 'code'

/**
 * Whether the code workspaces up already fill the cap. The cap counts inside the account's own limit, so it is never
 * above `maxSandboxes`. A provider that cannot list, or a listing that fails, does not hold a turn back: the account's
 * own wait (`untilSlotFree`) still does. The Vercel provider can neither list nor reconnect, so there the cap is not
 * enforced and a turn closes its workspace (snapshot, stop) instead of leaving it up.
 */
export async function codeCapReached(
  provider: { maxSandboxes?: number; listSandboxes?(): Promise<ListedSandbox[]> },
  cap: number,
): Promise<boolean> {
  if (!provider.listSandboxes) return false
  const limit = Math.min(cap, provider.maxSandboxes ?? cap)
  try {
    return (await provider.listSandboxes()).filter(isCodeWorkspace).length >= limit
  } catch {
    return false
  }
}

/** Namespaces the advisory lock that serialises the start of code workspaces. */
const CAP_LOCK = 569

/** Runs `work` holding the cap's lock, transaction-scoped so it always ends: one start at a time, on any process. */
export async function underCapLock<T>(db: Database, work: () => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${CAP_LOCK}, 0)`)
    return work()
  })
}

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
 * own wait (`untilSlotFree`) still does.
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

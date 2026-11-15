type Timeouts = { sandboxMs: number; agentMs: number; checkMs?: number; reviewMs?: number }

/** The least and the most an owner may give a run. The drain of a deploy waits for the most. */
export const MIN_RUN_MINUTES = 30
export const MAX_RUN_MINUTES = 240
export const MAX_RUN_MS = MAX_RUN_MINUTES * 60_000

/**
 * The limits of one run: the owner's saved limit for the repository when there is one, else `base`.
 * A task's run and an evaluation case both ask here, so they plan the same time.
 */
export function resolveTimeouts(base: Timeouts, savedMs: number | undefined): Timeouts {
  return savedMs === undefined || savedMs === base.sandboxMs
    ? base
    : { ...base, sandboxMs: savedMs }
}

import { MAX_RUN_MINUTES } from '../../shared/panel'
import { DEFAULT_CHECK_MS, DEFAULT_REVIEW_MS, MIN_AGENT_MS } from './agent-time'

type Timeouts = { sandboxMs: number; agentMs: number; checkMs?: number; reviewMs?: number }

/** Time before the first agent pass is planned: the sandbox starts, the repository is cloned, dependencies installed. */
const STARTUP_MARGIN_MS = 20 * 60_000

/**
 * The least an owner may give a run leaves room for the startup, the time kept for checks and review, and one
 * agent pass worth starting, so a saved value never fails before its first pass. The panel validates against
 * `MIN_RUN_MINUTES` in `shared/panel.ts`, which a test keeps equal to this.
 */
export const LEAST_RUN_MS = STARTUP_MARGIN_MS + DEFAULT_CHECK_MS + DEFAULT_REVIEW_MS + MIN_AGENT_MS
/** The most an owner may give a run. The drain of a deploy waits for it. */
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

/**
 * Whether a repository's line is stopped, as one decision over what was read. Nothing here reads or writes:
 * `promotion-watch.ts` reads the promotion and `apply.ts` writes what this decides.
 *
 * A red promotion holds every release of the repository, and every task integrated behind it waits for that
 * release to close its issue. Fixing it check by check never ends: each fix waits for the others, while the
 * other tasks keep moving the branch. So the line stops: one incident, one fix for all the failures, nothing
 * new runs or integrates until the promotion is green again.
 */

/** Fix issues an incident files before it goes to a person: the first, and one after it integrated and the line stayed red. */
export const MAX_ATTEMPTS = 2

export type IncidentStatus = 'open' | 'escalated' | 'resolved'

export type OpenIncident = {
  status: Exclude<IncidentStatus, 'resolved'>
  issueNumber: number
  lastSha: string
  attempts: number
}

export type LineFacts = {
  incident?: OpenIncident
  /** The head of the promotion pull request now. */
  head: string
  /** How many checks the factory could fix failed on the head. */
  failures: number
  /** No check of the head is still queued or running. */
  settled: boolean
  /** The incident's fix is over: it integrated, or its issue was closed. Undefined without an incident. */
  fixEnded?: boolean
}

export type LineStep =
  | { kind: 'none' }
  /** Stop the line: file one issue for every failure of the head. */
  | { kind: 'open' }
  /** The head moved while the fix is on its way: tell the fix what fails now. */
  | { kind: 'note' }
  /** The fix ended and the line is still red: a new fix, which links the last. */
  | { kind: 'retry' }
  /** The fixes ran out: one issue for a person, and the line stays stopped. */
  | { kind: 'escalate' }
  /** Green again: the line runs. */
  | { kind: 'resolve' }

const NONE: LineStep = { kind: 'none' }

export function decideLine(facts: LineFacts): LineStep {
  const { incident, head, failures, settled } = facts
  if (!incident) return failures > 0 ? { kind: 'open' } : NONE
  if (failures === 0) return settled ? { kind: 'resolve' } : NONE
  if (head === incident.lastSha) return NONE
  if (!facts.fixEnded || incident.status === 'escalated') return { kind: 'note' }
  return incident.attempts < MAX_ATTEMPTS ? { kind: 'retry' } : { kind: 'escalate' }
}

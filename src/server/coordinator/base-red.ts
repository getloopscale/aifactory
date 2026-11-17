import type { Read } from '../factory/doctor'
import type { BaseRed } from '../factory/ci-wait'

import type { TaskException } from './exceptions'

/**
 * The integration branch that stays red while tasks wait on it (#153, #179): a required check that fails on
 * a task's pull request and on the head of the integration branch too holds the task, and a hold that lasts
 * past `BASE_RED_LIMIT_MS` is an exception for a person, as a red release branch is. Pure: it reads nothing.
 */

/** How long the integration branch may stay red for a task before the coordinator escalates it. */
export const BASE_RED_LIMIT_MS = 2 * 60 * 60_000

/** A task that waits for CI, and the hold its `done` event records: the checks red on the branch now. */
export type BaseRedFacts = {
  taskId: number
  /** The commit the task waits on. */
  head: string
  /** The current hold, none when no check is red on the branch, or why the event could not be read. */
  red: Read<BaseRed | undefined>
}

const short = (sha: string) => sha.slice(0, 7)

const hours = (ms: number) => (ms / 3_600_000).toFixed(1)

/** A hold is the commit and the checks red on the branch, so a different check red on the same commit is a new hold. */
export const holdIdentity = (head: string, checks: string[]) =>
  `${head}:${[...checks].sort().join(',')}`

/** The `base_red` exception of a task held longer than the limit, or none; an unread hold is `unknown`. */
export function recogniseBaseRed(facts: BaseRedFacts, now: Date): TaskException | undefined {
  const { taskId, head } = facts
  if (!facts.red.read) {
    const evidence = `could not read ${facts.red.tried}: ${facts.red.error}`
    return { kind: 'unknown', taskId, head, evidence }
  }
  const red = facts.red.value
  if (!red) return undefined
  const for_ = now.getTime() - Date.parse(red.since)
  if (for_ <= BASE_RED_LIMIT_MS) return undefined
  return {
    kind: 'base_red',
    taskId,
    head: holdIdentity(head, red.checks),
    evidence: `${red.checks.join(', ')} fails on ${red.base} as on ${short(head)}, red for ${hours(for_)} hours`,
  }
}

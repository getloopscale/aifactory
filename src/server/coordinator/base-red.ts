import type { BaseBlame } from '../factory/ci-wait'

import type { TaskException } from './exceptions'

/**
 * The integration branch that stays red while tasks wait on it (#153, #179): a required check that fails on
 * a task's pull request and on the head of the integration branch too holds the task, and a hold that lasts
 * past `BASE_RED_LIMIT_MS` is an exception for a person, as a red release branch is. Pure: it reads nothing.
 */

/** How long the integration branch may stay red for a task before the coordinator escalates it. */
export const BASE_RED_LIMIT_MS = 2 * 60 * 60_000

/** A task that waits for CI, and what its `done` event blames on the integration branch. */
export type BaseRedFacts = {
  taskId: number
  /** The commit the task waits on. */
  head: string
  blame: BaseBlame | undefined
}

const short = (sha: string) => sha.slice(0, 7)

const hours = (ms: number) => (ms / 3_600_000).toFixed(1)

/** The `base_red` exception of a task held longer than the limit, or none. */
export function recogniseBaseRed(facts: BaseRedFacts, now: Date): TaskException | undefined {
  const { blame } = facts
  if (!blame || blame.checks.length === 0 || !blame.since) return undefined
  const red = now.getTime() - Date.parse(blame.since)
  if (red <= BASE_RED_LIMIT_MS) return undefined
  const branch = blame.base ?? 'the integration branch'
  return {
    kind: 'base_red',
    taskId: facts.taskId,
    head: facts.head,
    evidence: `${blame.checks.join(', ')} fails on ${branch} as on ${short(facts.head)}, red for ${hours(red)} hours`,
  }
}

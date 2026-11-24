/**
 * How a failed run starts its reason, for the failures the coordinator acts on (`coordinator/exceptions.ts`).
 * The run writes them and the coordinator recognises them from here, so a change to the wording changes both.
 */

/** The checks did not pass on the last commit and no attempt was left: `no pull request: "lint" failed at abc1234`. */
export const NO_PULL_REQUEST = 'no pull request: '

/**
 * The agent changed nothing because what it needs does not exist yet (a release, an issue, a branch). It is not
 * `NO_CHANGE`, so the coordinator does not send the work back for nothing: a person reads it.
 */
export const BLOCKED_NO_CHANGE =
  'blocked, the agent made no change: what it needs does not exist yet'

/** The agent left the repository as it found it. */
export const NO_CHANGE = 'the agent made no change to the repository'

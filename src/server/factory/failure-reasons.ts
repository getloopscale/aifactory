/**
 * How a failed run starts its reason, for the failures the coordinator acts on (`coordinator/exceptions.ts`).
 * The run writes them and the coordinator recognises them from here, so a change to the wording changes both.
 */

/** The checks did not pass on the last commit and no attempt was left: `no pull request: "lint" failed at abc1234`. */
export const NO_PULL_REQUEST = 'no pull request: '

/** The agent left the repository as it found it. */
export const NO_CHANGE = 'the agent made no change to the repository'

import { countRequests, noRequests, rateGate, type RateGate } from './rate-limit'

export type GithubPassOptions = {
  /**
   * A cron that only polls GitHub skips its pass while the installation's budget is under its reserve, and
   * runs again after the reset. One that also does work of its own (orders the queue, starts tasks) does not.
   */
  waitsForLimit?: boolean
  gate?: RateGate
  log?: (line: string) => void
}

/** The budget the factory's polling spends: the installation's core limit, which every repository shares. */
const POLLED = 'installation:core' as const

/**
 * A cron pass with its spend of the GitHub budget on one line (`github_requests`): the calls it made by
 * kind of token and what GitHub said is left, so the log says which cron spends the hour. A polling cron
 * (`waitsForLimit`) waits for the reset instead of asking GitHub for refusals, and says so once per reset.
 */
export function githubPass<T>(
  cron: string,
  handler: () => Promise<T>,
  options: GithubPassOptions = {},
): () => Promise<T | undefined> {
  const gate = options.gate ?? rateGate
  const log = options.log ?? ((line: string) => console.log(line))
  let saidUntil: string | undefined
  return async () => {
    const until = options.waitsForLimit ? gate.waitUntil(POLLED) : undefined
    if (until) {
      if (saidUntil !== until.toISOString()) {
        saidUntil = until.toISOString()
        const budget = gate.budget(POLLED)
        log(
          JSON.stringify({
            event: 'github_pass_waits',
            cron,
            until: saidUntil,
            remaining: budget?.remaining,
            limit: budget?.limit,
          }),
        )
      }
      return undefined
    }
    const requests = noRequests()
    try {
      return (await countRequests(handler, requests)).value
    } finally {
      if (requests.installation + requests.app + requests.other > 0) {
        const budget = gate.budget(POLLED)
        log(
          JSON.stringify({
            event: 'github_requests',
            cron,
            ...requests,
            remaining: budget?.remaining,
            limit: budget?.limit,
            resetAt: budget?.resetAt.toISOString(),
          }),
        )
      }
    }
  }
}

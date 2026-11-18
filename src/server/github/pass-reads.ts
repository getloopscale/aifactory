import type { GithubApi } from './pulls'

/**
 * The reads of one cron pass that many tasks share, each asked of GitHub once (paulohenriquevn/aifactory#232).
 * Fifteen tasks waiting on one integration branch read its head, its checks and its required checks fifteen
 * times a pass without it, every two minutes.
 */
const SHARED = ['branchHead', 'requiredChecks', 'checkReports'] as const
type Shared = (typeof SHARED)[number]

/** The calls that move a branch: after one, the heads read in its repository are read again. */
const MOVES = new Set<string>(['mergePullRequest', 'mergeBranch', 'createBranch', 'deleteBranch'])

type Call = (...args: unknown[]) => Promise<unknown>

/**
 * `api` for one pass: a shared read with the same repository and arguments is answered from the first ask,
 * a failure included, so a pass that GitHub refuses once does not ask again for every task. The token is not
 * part of the key: it is the repository's. A call that moves a branch forgets the heads read in that
 * repository. Make a new one for every pass; nothing is kept between passes.
 */
export function passReads(api: GithubApi): GithubApi {
  const asked = new Map<string, Promise<unknown>>()
  // Looked up at the call, so a partial api in a test needs only the methods the pass uses.
  const original =
    (name: string): Call =>
    (...args) =>
      (api[name as keyof GithubApi] as Call).apply(api, args)
  const shared = (name: Shared): Call => {
    const read = original(name)
    return (repo, token, ...rest) => {
      const key = JSON.stringify([name, repo, ...rest])
      if (!asked.has(key)) asked.set(key, read(repo, token, ...rest))
      return asked.get(key)!
    }
  }
  const forgetHeads = (repo: unknown) => {
    const prefix = JSON.stringify(['branchHead', repo]).slice(0, -1)
    for (const key of asked.keys()) if (key.startsWith(prefix)) asked.delete(key)
  }
  const moving = (name: string): Call => {
    const write = original(name)
    return async (...args) => {
      try {
        return await write(...args)
      } finally {
        forgetHeads(args[0])
      }
    }
  }
  const wrapped = new Map<string, Call>(SHARED.map((name) => [name, shared(name)]))
  for (const name of MOVES) wrapped.set(name, moving(name))
  return new Proxy(api, {
    get: (target, property, receiver) =>
      typeof property === 'string' && wrapped.has(property)
        ? wrapped.get(property)
        : Reflect.get(target, property, receiver),
  })
}

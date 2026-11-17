import type { ReadIssue } from '../coordinator/draft'
import type { Issue } from '../github/issues'

/** Lists the open issues of a repository that the factory works on. */
export type ListIssues = (repo: string, token: string) => Promise<Issue[]>

/**
 * A `ReadIssue` for one pass of the scheduler: each repository is listed once and its queued issues are
 * taken from the listing, so a pass costs one call per repository rather than one per queued task. An issue
 * the listing lacks (closed, or no longer labelled) is read by itself. A listing that failed is not kept,
 * so the next read asks again.
 */
export function listingReader(list: ListIssues, readOne: ReadIssue): ReadIssue {
  const listings = new Map<string, Promise<Map<number, Issue>>>()
  return async (repo, number, token) => {
    let listing = listings.get(repo)
    if (!listing) {
      listing = list(repo, token).then((issues) => new Map(issues.map((i) => [i.number, i])))
      listings.set(repo, listing)
      listing.catch(() => listings.delete(repo))
    }
    return (await listing).get(number) ?? readOne(repo, number, token)
  }
}

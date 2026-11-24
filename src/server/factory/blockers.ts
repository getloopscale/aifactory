/** An issue in a repository, as `owner/repo#number` names it. */
export type IssueRef = { repository: string; number: number }

const DECLARATION = /^[\s*_>-]*blocked by\b(.*)$/gim
const REFERENCE = /(?:\b([\w.-]+\/[\w.-]+))?#(\d+)\b/g

/** How a blocker is written on a failure: `owner/repo#number`. */
export const nameOf = (ref: IssueRef) => `${ref.repository}#${ref.number}`

/**
 * The issues an issue says it waits for, from each line that starts with "Blocked by". A reference without a
 * repository is to the issue's own. Other links in the body are context, not blockers.
 */
export function declaredBlockers(body: string, repository: string): IssueRef[] {
  const found = new Map<string, IssueRef>()
  for (const [, rest] of body.matchAll(DECLARATION)) {
    for (const [, repo, number] of (rest ?? '').matchAll(REFERENCE)) {
      const ref = { repository: repo ?? repository, number: Number(number) }
      found.set(nameOf(ref), ref)
    }
  }
  return [...found.values()]
}

/** The blockers `isOpen` says are still open, in the order they were declared. */
export async function openBlockers(
  blockers: IssueRef[],
  isOpen: (ref: IssueRef) => Promise<boolean>,
): Promise<IssueRef[]> {
  const open = await Promise.all(blockers.map(isOpen))
  return blockers.filter((_, i) => open[i])
}

/**
 * A task whose issue waits for others still open. An issue closes once what fixes it is released, so the task
 * waits for that instead of starting work on something that does not exist yet.
 */
export class BlockedByOpenIssues extends Error {
  readonly blockedBy: string[]

  constructor(open: IssueRef[]) {
    const names = open.map(nameOf)
    super(
      `blocked by ${names.join(', ')}, still open; the task runs again on its own once they are closed`,
    )
    this.name = 'BlockedByOpenIssues'
    this.blockedBy = names
  }
}

/** A blocker recorded as `owner/repo#number` read back as an issue; anything else is not one. */
export function refOf(name: string): IssueRef | undefined {
  const match = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(name)
  return match ? { repository: match[1], number: Number(match[2]) } : undefined
}

const WAITING_ON =
  /\b(?:blocked (?:by|on)|waiting (?:for|on)|depends on|dependent on|requires?|needs?|still open|not (?:yet )?(?:fixed|merged|resolved|closed|released|available))\b/i

/**
 * The issues the builder says it cannot go on without, from the sentences of its explanation that say it is
 * waiting for something. An issue named in passing is context, not a blocker, and the caller reads each one
 * on GitHub before treating it as one. A reference without a repository is to the task's own.
 */
export function blockersNamed(said: string, repository: string): IssueRef[] {
  const found = new Map<string, IssueRef>()
  for (const sentence of said.split(/(?<=[.;!?])\s+|\n+/)) {
    if (!WAITING_ON.test(sentence)) continue
    for (const [, repo, number] of sentence.matchAll(REFERENCE)) {
      const ref = { repository: repo ?? repository, number: Number(number) }
      found.set(nameOf(ref), ref)
    }
  }
  return [...found.values()]
}

const UNAVAILABLE =
  /\b(?:(?:not|never) (?:yet )?(?:been )?(?:published|released)|unpublished|unreleased|no (?:such )?(?:release|version) (?:exists|of)|branch\b[^.]{0,80}\b(?:not (?:yet )?merged|does not exist|unmerged)|(?:unmerged|unpushed) branch)/i

/** The sentence in which the builder says a release, a package version or a branch it needs does not exist yet. */
export function unavailableNamed(said: string): string | undefined {
  return said
    .split(/(?<=[.;!?])\s+|\n+/)
    .find((s) => UNAVAILABLE.test(s))
    ?.trim()
}

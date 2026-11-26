/**
 * What the improver does for each enabled repository. Pure: `facts.ts` reads what these functions decide
 * over, and `apply.ts` does what they say.
 */

/** The kinds of maintenance the improver proposes, closed. A new kind is a new entry here and in the prompts. */
export const IMPROVER_KINDS = ['duplicate_code', 'missing_test', 'stale_doc'] as const
export type ImproverKind = (typeof IMPROVER_KINDS)[number]

/** How many repositories one pass may propose for. */
export const PER_PASS = 3

export type RepoFacts = {
  repository: string
  /** A task is queued, running, waiting for an answer or waiting for CI. */
  busy: boolean
  /** A line incident of the repository is open. */
  lineStopped: boolean
  /** A task is held by a red integration branch. */
  baseHeld: boolean
  /** The issue the improver filed last: still open, or not read. `null` when none is open. */
  openIssue: { number: number } | 'unread' | null
  /** When the repository was last scouted for each kind (proposed or nothing found). */
  scouted: Partial<Record<ImproverKind, Date>>
  /** The repository already got a proposal on this UTC day, in `trial` or in `auto`. */
  proposedToday: boolean
}

export type SkipReason =
  | 'owner_work'
  | 'line_stopped'
  | 'base_held'
  | 'open_issue'
  | 'unread'
  | 'already_today'
  | 'pass_limit'

export const SKIP_TEXT: Record<SkipReason, string> = {
  owner_work: 'a task of the repository is queued, running or waiting: the owner’s work goes first',
  line_stopped: 'the repository’s line is stopped',
  base_held: 'a task of the repository is held by a red integration branch',
  open_issue: 'an issue the improver filed for the repository is still open',
  unread: 'the issue the improver filed last could not be read',
  already_today: 'the repository already got a proposal today',
  pass_limit: 'the pass already proposed for as many repositories as it may',
}

export type RepoDecision =
  | { action: 'scout'; kind: ImproverKind }
  | { action: 'skip'; reason: SkipReason; kind: ImproverKind }

/** The kind scouted least recently for the repository; a kind never scouted is the oldest, and a tie keeps the list's order. */
export function nextKind(scouted: Partial<Record<ImproverKind, Date>>): ImproverKind {
  let best: ImproverKind = IMPROVER_KINDS[0]
  let bestTime = scouted[best]?.getTime() ?? -Infinity
  for (const kind of IMPROVER_KINDS.slice(1)) {
    const time = scouted[kind]?.getTime() ?? -Infinity
    if (time < bestTime) {
      best = kind
      bestTime = time
    }
  }
  return best
}

/** The first UTC instant of the day `now` falls in. */
export const startOfDay = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))

/** The repositories in a fixed order that starts one further each day, so the pass limit starves none. */
export function orderRepositories<T extends { repository: string }>(repos: T[], now: Date): T[] {
  const sorted = [...repos].sort((a, b) => a.repository.localeCompare(b.repository))
  if (sorted.length === 0) return sorted
  const shift = Math.floor(startOfDay(now).getTime() / 86_400_000) % sorted.length
  return [...sorted.slice(shift), ...sorted.slice(0, shift)]
}

/** Why a repository is skipped, or nothing when it may be scouted. */
export function skipReason(repo: RepoFacts, proposedInPass: number, perPass = PER_PASS) {
  if (repo.baseHeld) return 'base_held'
  if (repo.lineStopped) return 'line_stopped'
  if (repo.busy) return 'owner_work'
  if (repo.openIssue === 'unread') return 'unread'
  if (repo.openIssue) return 'open_issue'
  if (repo.proposedToday) return 'already_today'
  if (proposedInPass >= perPass) return 'pass_limit'
  return undefined
}

/** What to do for one repository, given how many the pass has proposed for already. */
export function decideRepository(
  repo: RepoFacts,
  proposedInPass: number,
  perPass = PER_PASS,
): RepoDecision {
  const kind = nextKind(repo.scouted)
  const reason = skipReason(repo, proposedInPass, perPass)
  return reason ? { action: 'skip', reason, kind } : { action: 'scout', kind }
}

/** The signature an issue is filed once under. */
export const improveSignature = (kind: ImproverKind, target: string) => `improve:${kind}:${target}`

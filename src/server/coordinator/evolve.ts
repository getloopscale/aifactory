import type { CoordinatorMode } from './mode'

/**
 * Evolve: a failure that repeats across tasks is a defect of the factory, so the coordinator files it as an
 * issue for the factory and later measures whether it stopped (ADR 0011, section 5). This module decides
 * and reads nothing: `evolve-facts.ts` reads, `evolve-apply.ts` writes.
 */

const DAY_MS = 86_400_000

export const EVOLVE = {
  /** The repository the issues go to, and the label that makes the factory take them. */
  repository: 'paulohenriquevn/aifactory',
  label: 'factory',
  /** How far back a pass looks for a signature, and the windows the effect compares. */
  windowDays: 7,
  /** On how many distinct tasks a signature has to be seen to be filed. */
  minTasks: 3,
  /**
   * In how many separate incidents. Events less than `incidentGapMs` apart are one incident: an outage that
   * stops a whole queue at once is one cause, not a failure that keeps coming back.
   */
  minIncidents: 2,
  incidentGapMs: 3_600_000,
  /** How many issues one pass files, and how many the window holds. */
  perPass: 1,
  perWindow: 3,
  signatureLength: 200,
  titleLength: 120,
  reasonQuoted: 500,
  eventsListed: 20,
} as const

/** The waits the factory was designed to have: a signature that starts with one, or that names a provider limit, is never filed. */
export const DESIGNED_WAITS = ['blocked by', 'waiting for an answer'] as const

/** The provider refusing to serve the account (spend or usage limit, matched on the signature, where numbers are already `<n>`): a state of the account, not a defect to fix here. */
const PROVIDER_LIMIT = /spend_limit|usage limit exceeded/i

/** A `failed` or `handoff` event of a task, with the reason it recorded. */
export type FailureEvent = {
  taskId: number
  repository: string
  issueNumber: number
  stage: 'failed' | 'handoff'
  reason: string
  at: Date
}

export type SignatureGroup = {
  signature: string
  /** Ordered by time. */
  events: FailureEvent[]
  /** How many distinct tasks the events belong to. */
  tasks: number
  /** How many separate incidents the events make (`EVOLVE.incidentGapMs`). */
  incidents: number
  firstSeen: Date
  lastSeen: Date
}

const URL = /\bhttps?:\/\/\S+/g
const PATH = /~?\/?(?:[\w.-]+\/)+[\w.-]+/g
// A commit id has a digit: a word made only of the letters a to f is a word.
const COMMIT = /\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/gi
/** The cause `errorMessage` adds to a failed fetch: it varies by network state, so the signature stays `fetch failed`, as before the cause was recorded. */
const FETCH_CAUSE = /^(\s*fetch failed) \(cause: [\s\S]*\)\s*$/
const NUMBER = /\d+/g
const LONG_DASH = /[\u2013\u2014]/g

const hyphens = (text: string) => text.replace(LONG_DASH, '-')

/**
 * What stays of a reason when what changes from one task to the next is taken out: its first line with
 * text, with URLs, paths, commit ids and numbers replaced by placeholders, spaces collapsed, cut to a length.
 */
export function signatureOf(reason: string): string {
  const line =
    reason
      .replace(FETCH_CAUSE, '$1')
      .split('\n')
      .find((l) => l.trim() !== '') ?? ''
  return hyphens(
    line
      .replace(FETCH_CAUSE, '$1')
      .replace(URL, '<url>')
      .replace(PATH, '<path>')
      .replace(COMMIT, '<sha>')
      .replace(NUMBER, '<n>'),
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, EVOLVE.signatureLength)
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')

/** The reason an event recorded: a handoff's `reason`, a failure's `error`. */
export function reasonOf(detail: Record<string, unknown> | null): string {
  return text(detail?.reason) || text(detail?.error)
}

export function isDesignedWait(signature: string): boolean {
  const lower = signature.toLowerCase()
  return PROVIDER_LIMIT.test(signature) || DESIGNED_WAITS.some((wait) => lower.startsWith(wait))
}

/** How many incidents events ordered by time make: a gap of `EVOLVE.incidentGapMs` or more starts one. */
function incidentsOf(ordered: FailureEvent[]): number {
  let incidents = 1
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].at.getTime() - ordered[i - 1].at.getTime() >= EVOLVE.incidentGapMs) incidents++
  }
  return incidents
}

/** The events by signature. An event whose reason has no text has no signature and is left out. */
export function groupBySignature(events: FailureEvent[]): SignatureGroup[] {
  const bySignature = new Map<string, FailureEvent[]>()
  for (const e of events) {
    const signature = signatureOf(e.reason)
    if (signature === '') continue
    bySignature.set(signature, [...(bySignature.get(signature) ?? []), e])
  }
  return [...bySignature].map(([signature, list]) => {
    const ordered = [...list].sort((a, b) => a.at.getTime() - b.at.getTime())
    return {
      signature,
      events: ordered,
      tasks: new Set(ordered.map((e) => e.taskId)).size,
      incidents: incidentsOf(ordered),
      firstSeen: ordered[0].at,
      lastSeen: ordered[ordered.length - 1].at,
    }
  })
}

/**
 * The signatures this pass files: on enough tasks, in more than one incident, not a designed wait, not filed before, the one on the
 * most tasks first (then the one seen first, then by name), within what the pass and the window allow.
 */
export function toFile(
  groups: SignatureGroup[],
  filed: ReadonlySet<string>,
  filedInWindow: number,
): SignatureGroup[] {
  const room = Math.max(0, Math.min(EVOLVE.perPass, EVOLVE.perWindow - filedInWindow))
  return groups
    .filter(
      (g) =>
        g.tasks >= EVOLVE.minTasks &&
        g.incidents >= EVOLVE.minIncidents &&
        !isDesignedWait(g.signature) &&
        !filed.has(g.signature),
    )
    .sort(
      (a, b) =>
        b.tasks - a.tasks ||
        a.firstSeen.getTime() - b.firstSeen.getTime() ||
        a.signature.localeCompare(b.signature),
    )
    .slice(0, room)
}

/** A fence longer than any run of tildes in the text, so the text inside renders as it is. */
function fenced(content: string): string {
  const longest = Math.max(0, ...(content.match(/~+/g) ?? []).map((run) => run.length))
  const fence = '~'.repeat(Math.max(3, longest + 1))
  return `${fence}text\n${content}\n${fence}`
}

function listed(e: FailureEvent): string {
  return [
    `- Task ${e.taskId}, ${e.repository}#${e.issueNumber}, ${e.stage} at ${e.at.toISOString()}:`,
    '',
    fenced(e.reason.slice(0, EVOLVE.reasonQuoted)),
  ].join('\n')
}

/** The issue a signature becomes: the signature, its events, when it was seen and how to see it again. */
export function issueForSignature(g: SignatureGroup): { title: string; body: string } {
  const shown = g.events.slice(0, EVOLVE.eventsListed)
  const more = g.events.length - shown.length
  const body = [
    '**Area:** coordinator (ADR 0011, Evolve)',
    '',
    `The same failure ended ${g.tasks} tasks in the last ${EVOLVE.windowDays} days. Its signature, the reason with numbers, commit ids, paths and URLs replaced:`,
    '',
    fenced(g.signature),
    '',
    `First seen: ${g.firstSeen.toISOString()}. Last seen: ${g.lastSeen.toISOString()}.`,
    '',
    '## Tasks',
    '',
    ...shown.flatMap((e) => [listed(e), '']),
    ...(more > 0 ? [`And ${more} more events.`, ''] : []),
    '## Repro',
    '',
    '1. Open each task above in the panel. Its `failed` or `handoff` event carries the reason quoted here.',
    '2. Pass each reason to `signatureOf` in `src/server/coordinator/evolve.ts`: every one gives the signature above.',
    `3. Fix the cause, and the signature stops showing up on new tasks. The coordinator opens no other issue for it, and ${EVOLVE.windowDays} days after this one closes it counts the signature against the ${EVOLVE.windowDays} days before this issue, commenting here when it still shows up.`,
  ].join('\n')
  const title = `coordinator: the same failure ended ${g.tasks} tasks in ${EVOLVE.windowDays} days: ${g.signature}`
  return { title: hyphens(title).slice(0, EVOLVE.titleLength), body: hyphens(body) }
}

/**
 * The comment on a closed issue whose failure still happens after the close, naming both counts, or
 * nothing when the failure stopped.
 */
export function effectComment(
  signature: string,
  before: number,
  after: number,
): string | undefined {
  if (after === 0) return undefined
  return hyphens(
    [
      `The failure this issue was filed for still happens after it closed: ${before} times in the ${EVOLVE.windowDays} days before this issue was filed, ${after} in the ${EVOLVE.windowDays} days after it closed. The signature:`,
      '',
      fenced(signature),
    ].join('\n'),
  )
}

/** What a read of the issue said. A reader that does not know the state leaves it out. */
export type IssueState = { state?: 'open' | 'closed'; closedAt?: Date }

/** Whether the issue closed long enough ago for the window after its close to be over. */
export function measurable(issue: IssueState, now: Date): boolean {
  if (issue.state !== 'closed' || !issue.closedAt) return false
  return now.getTime() - issue.closedAt.getTime() >= EVOLVE.windowDays * DAY_MS
}

export type EvolveResult = {
  filed: { signature: string; issueNumber: number }[]
  /** What a `trial` pass would have filed. It files and records nothing. */
  wouldFile: { signature: string; taskIds: number[] }[]
  measured: {
    signature: string
    issueNumber: number
    before: number
    after: number
    commented: boolean
  }[]
  failed: { signature: string; error: string }[]
}

/** What a pass logs: one line when it filed, would file, measured or failed anything; nothing otherwise. */
export function evolveLog(result: EvolveResult, mode: CoordinatorMode): string[] {
  const quiet = Object.values(result).every((list) => list.length === 0)
  return quiet ? [] : [JSON.stringify({ event: 'coordinator_evolve', mode, ...result })]
}

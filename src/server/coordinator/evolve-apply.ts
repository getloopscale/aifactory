import { and, eq, isNull } from 'drizzle-orm'

import type { Database } from '../db'
import { failureSignature } from '../db/schema'
import { fetchIssue } from '../github/issues'
import {
  createIssuesApi,
  issueOpener,
  type CreatedIssue,
  type IssuesApi,
  type NewIssue,
} from '../github/issues-api'
import type { ActionDeps } from '../panel/actions'

import {
  EVOLVE,
  effectComment,
  groupBySignature,
  issueForSignature,
  measurable,
  toFile,
  type EvolveResult,
  type IssueState,
  type SignatureGroup,
} from './evolve'
import { countSignature, readFailureEvents, readFiledSignatures } from './evolve-facts'
import { fileOnce } from './file-once'
import type { CoordinatorMode } from './mode'

/**
 * The side effects of Evolve: it records a filed signature in `failure_signature`, opens its issue on the
 * factory's repository, and, a week after that issue closes, records the effect and comments when the
 * failure still happens. In `trial` it only answers what it would file, and in `off` it does nothing.
 */

const DAY_MS = 86_400_000
const WINDOW_MS = EVOLVE.windowDays * DAY_MS

export type EvolveDeps = {
  db: Database
  now?: () => Date
  openIssue: (repository: string, issue: NewIssue) => Promise<CreatedIssue>
  /** The state of an issue. A read that fails throws, and the issue is not measured on this pass. */
  readIssue: (repository: string, number: number) => Promise<IssueState>
  comment: (repository: string, number: number, body: string) => Promise<void>
}

/** Evolve's GitHub, through the App: every token is scoped to the repository it writes to or reads. */
export function evolveDeps(
  deps: Pick<ActionDeps, 'db' | 'github' | 'api'>,
  issues: Pick<IssuesApi, 'createIssue'> = createIssuesApi(),
  read: typeof fetchIssue = fetchIssue,
): EvolveDeps {
  const token = async (repository: string) =>
    (await deps.github.installationToken(repository)).token
  return {
    db: deps.db,
    openIssue: issueOpener(deps.github, issues),
    readIssue: async (repository, number) => {
      const { state, closedAt } = await read(repository, number, await token(repository))
      return { state, closedAt }
    },
    comment: async (repository, number, body) => {
      await deps.api.commentOnIssue(repository, await token(repository), number, body)
    },
  }
}

type FiledRow = Awaited<ReturnType<typeof readFiledSignatures>>[number]

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

function failedTo(result: EvolveResult, event: string, signature: string, error: unknown) {
  console.error(JSON.stringify({ event, signature, error: message(error) }))
  result.failed.push({ signature, error: message(error) })
}

/** Files one signature, once (`fileOnce`): a pass that raced this one files nothing. */
async function file(deps: EvolveDeps, g: SignatureGroup, now: Date, result: EvolveResult) {
  const { title, body } = issueForSignature(g)
  const claim = { signature: g.signature, repository: EVOLVE.repository, now }
  try {
    const filed = await fileOnce(deps.db, claim, () =>
      deps.openIssue(EVOLVE.repository, { title, body, labels: [EVOLVE.label] }),
    )
    if ('filed' in filed) {
      result.filed.push({ signature: g.signature, issueNumber: filed.filed.number })
    }
  } catch (error) {
    failedTo(result, 'coordinator_evolve_failed', g.signature, error)
  }
}

/** The state of the issue, or nothing when it could not be read: then it is not measured, never guessed. */
async function stateOf(deps: EvolveDeps, row: FiledRow, issueNumber: number, result: EvolveResult) {
  try {
    return await deps.readIssue(row.repository, issueNumber)
  } catch (error) {
    failedTo(result, 'coordinator_evolve_unread', row.signature, error)
    return undefined
  }
}

/**
 * Measures a filed signature whose issue closed a week ago or more: its events in the week after the close
 * against the week before it was filed. The comment goes first, so a comment that fails leaves the row
 * unmeasured and the next pass tries again.
 */
async function measureEffect(
  deps: EvolveDeps,
  row: FiledRow,
  issueNumber: number,
  now: Date,
  result: EvolveResult,
) {
  const issue = await stateOf(deps, row, issueNumber, result)
  if (!issue || !measurable(issue, now)) return
  const closedAt = issue.closedAt!
  const before = await countSignature(
    deps.db,
    row.signature,
    new Date(row.filedAt.getTime() - WINDOW_MS),
    row.filedAt,
  )
  const after = await countSignature(
    deps.db,
    row.signature,
    closedAt,
    new Date(closedAt.getTime() + WINDOW_MS),
  )
  const comment = effectComment(row.signature, before, after)
  try {
    if (comment) await deps.comment(row.repository, issueNumber, comment)
  } catch (error) {
    failedTo(result, 'coordinator_evolve_comment_failed', row.signature, error)
    return
  }
  await deps.db
    .update(failureSignature)
    .set({ countBefore: before, countAfter: after, measuredAt: now })
    .where(and(eq(failureSignature.id, row.id), isNull(failureSignature.measuredAt)))
  result.measured.push({
    signature: row.signature,
    issueNumber,
    before,
    after,
    commented: comment !== undefined,
  })
}

/**
 * One pass of Evolve: the signatures of the last week's failures and handoffs, the one to file (at most one
 * per pass and three per week), then the effect of every filed issue that has been closed for a week.
 */
export async function evolve(deps: EvolveDeps, mode: CoordinatorMode): Promise<EvolveResult> {
  const result: EvolveResult = { filed: [], wouldFile: [], measured: [], failed: [] }
  if (mode === 'off') return result
  const now = (deps.now ?? (() => new Date()))()
  const since = new Date(now.getTime() - WINDOW_MS)
  const [events, filed] = await Promise.all([
    readFailureEvents(deps.db, since, now),
    readFiledSignatures(deps.db),
  ])
  const chosen = toFile(
    groupBySignature(events),
    new Set(filed.map((f) => f.signature)),
    filed.filter((f) => f.filedAt >= since).length,
  )
  if (mode === 'trial') {
    result.wouldFile = chosen.map((g) => ({
      signature: g.signature,
      taskIds: [...new Set(g.events.map((e) => e.taskId))],
    }))
    return result
  }
  for (const g of chosen) await file(deps, g, now, result)
  for (const row of filed) {
    if (row.issueNumber !== null && row.measuredAt === null) {
      await measureEffect(deps, row, row.issueNumber, now, result)
    }
  }
  return result
}

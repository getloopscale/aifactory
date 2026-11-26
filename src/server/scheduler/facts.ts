import { and, desc, eq, inArray, sql } from 'drizzle-orm'

import type { ReadIssue } from '../coordinator/draft'
import type { Database } from '../db'
import { schedulerDecision } from '../db/schema'
import { readOf, unread, type Read } from '../factory/doctor'
import { errorMessage } from '../factory/error-message'
import type { GithubApp } from '../github/app'
import type { Issue } from '../github/issues'

import type { RecordedOrder } from './order'
import type { ReadinessVerdict } from './readiness'

/**
 * What the scheduler reads, and nothing else: the queued `run-task` jobs, their issues as GitHub holds them
 * now, and the decisions already recorded. It decides nothing (`order.ts` and `readiness.ts` do). The queue
 * is LoopZero's `loopzero_jobs`, which has no call to reorder it (https://github.com/usetheokit/theokit/issues/2117).
 */

/** A `run-task` job no worker holds and that did not fail, of a task still in `intake`. */
export type QueuedRun = {
  jobId: string
  taskId: number
  repository: string
  issueNumber: number
  queuedAt: Date
  availableAt: Date
  /**
   * The scheduler may move it: it is due, and the coordinator does not hold it (`heldFrom`, `available_at`
   * 'infinity'). A run queued for later keeps its time.
   */
  movable: boolean
  /** The task's first run: nothing was sent back, resumed or merged into it. */
  firstRun: boolean
}

/** A queued run with its issue, or why the issue could not be read. */
export type QueuedRunWithIssue = QueuedRun & { issue: Read<Issue> }

export type FactsDeps = {
  db: Database
  github: Pick<GithubApp, 'installationToken'>
  readIssue: ReadIssue
}

type QueueRow = {
  job_id: string
  task_id: number
  repository: string
  issue_number: number
  created_at: Date | string
  available_at: Date | string
  movable: boolean
  first_run: boolean
}

/** The queued runs, in the order the queue serves them. */
export async function readQueuedRuns(db: Pick<Database, 'execute'>): Promise<QueuedRun[]> {
  const rows = await db.execute<QueueRow>(
    sql`select j.id as job_id, t.id as task_id, t.repository, t.issue_number, j.created_at,
          date_trunc('milliseconds', j.available_at) as available_at,
          (j.available_at <= now() and not (j.input ? 'heldFrom')) as movable,
          not (j.input ?| array['decisionId', 'feedback', 'resume', 'mergeBase']) as first_run
        from loopzero_jobs j join task t on t.id = (j.input->>'taskId')::int
        where j.name = 'run-task' and j.failed_at is null
          and (j.locked_until is null or j.locked_until < now()) and t.stage = 'intake'
        order by j.available_at, j.id`,
  )
  return rows.rows.map((r) => ({
    jobId: r.job_id,
    taskId: r.task_id,
    repository: r.repository,
    issueNumber: r.issue_number,
    queuedAt: new Date(r.created_at),
    availableAt: new Date(r.available_at),
    movable: r.movable,
    firstRun: r.first_run,
  }))
}

async function readIssueOf(
  deps: FactsDeps,
  run: QueuedRun,
  tokens: Map<string, Promise<{ token: string }>>,
): Promise<Read<Issue>> {
  try {
    if (!tokens.has(run.repository)) {
      tokens.set(run.repository, deps.github.installationToken(run.repository))
    }
    const { token } = await tokens.get(run.repository)!
    return readOf(await deps.readIssue(run.repository, run.issueNumber, token))
  } catch (error) {
    return unread(`the issue ${run.repository}#${run.issueNumber}`, errorMessage(error))
  }
}

/** The queued runs with their issues. One token is asked for each repository. */
export async function readQueue(deps: FactsDeps): Promise<QueuedRunWithIssue[]> {
  const runs = await readQueuedRuns(deps.db)
  const tokens = new Map<string, Promise<{ token: string }>>()
  return Promise.all(
    runs.map(async (run) => ({ ...run, issue: await readIssueOf(deps, run, tokens) })),
  )
}

type OrderDetail = { priority: number | null; bug: boolean; unblocks: number }

/** The last order decision of each task. */
export async function readRecordedOrders(
  db: Pick<Database, 'selectDistinctOn'>,
  taskIds: number[],
): Promise<Map<number, RecordedOrder>> {
  if (taskIds.length === 0) return new Map()
  const rows = await db
    .selectDistinctOn([schedulerDecision.taskId], {
      taskId: schedulerDecision.taskId,
      mode: schedulerDecision.mode,
      head: schedulerDecision.head,
      detail: schedulerDecision.detail,
    })
    .from(schedulerDecision)
    .where(and(inArray(schedulerDecision.taskId, taskIds), eq(schedulerDecision.kind, 'order')))
    .orderBy(schedulerDecision.taskId, desc(schedulerDecision.id))
  return new Map(
    rows.map((r) => {
      const { priority, bug, unblocks } = r.detail as OrderDetail
      return [r.taskId, { mode: r.mode, head: r.head, priority, bug, unblocks }]
    }),
  )
}

/** A readiness verdict recorded for one version of an issue. */
export type ReadinessRecord = {
  id: number
  verdict: ReadinessVerdict
  missing: string
  question: string
  blockedBy?: string[]
  reason?: string
  /** Criteria the drafter wrote for a `no_acceptance` verdict; an empty list is a draft that could not be used. */
  draft?: string[]
  /** The question asked on the issue for this verdict, once one was. */
  questionId?: number
}

/** The key of a readiness verdict: the task and the version of its issue. */
export const readinessKey = (taskId: number, head: string) => `${taskId}:${head}`

/** The readiness verdicts recorded for these tasks, by `readinessKey`. */
export async function readRecordedReadiness(
  db: Pick<Database, 'select'>,
  taskIds: number[],
): Promise<Map<string, ReadinessRecord>> {
  if (taskIds.length === 0) return new Map()
  const rows = await db
    .select()
    .from(schedulerDecision)
    .where(and(inArray(schedulerDecision.taskId, taskIds), eq(schedulerDecision.kind, 'readiness')))
  return new Map(
    rows.map((r) => {
      const detail = r.detail as Omit<ReadinessRecord, 'id'>
      return [readinessKey(r.taskId, r.head), { ...detail, id: r.id }]
    }),
  )
}

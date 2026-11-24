import type { Pool } from 'pg'

import { openAmong } from '../factory/blocker-check'
import { refOf } from '../factory/blockers'
import { errorMessage } from '../factory/error-message'

import { applyOrder, askOwner, blockTask, recordDecision, type AskDeps } from './apply'
import {
  readinessKey,
  readQueue,
  readRecordedOrders,
  readRecordedReadiness,
  type FactsDeps,
  type QueuedRunWithIssue,
  type ReadinessRecord,
} from './facts'
import type { ReadinessJudge } from './judge'
import { passIsOff, type SchedulerMode, type SchedulerModes } from './mode'
import {
  isBug,
  orderHead,
  orderToRecord,
  planOrder,
  priorityOf,
  unblocksOf,
  type Placement,
  type QueuedEntry,
} from './order'
import { bodyHash, parseReadiness, readinessMessage, readinessStep } from './readiness'

/**
 * One pass of the scheduler: first the readiness of each newly queued issue (the only step with a model),
 * then the order of the queued runs. It reads the facts (`facts.ts`), decides with pure functions
 * (`readiness.ts`, `order.ts`), records every decision and, in `auto` only, applies it (`apply.ts`). In
 * `trial` nothing changes on a job, a task or an issue.
 */

export type SchedulerDeps = FactsDeps & AskDeps & { judge: ReadinessJudge }

export type ScheduleResult = {
  judged: number
  asked: number
  recorded: number
  moved: number
  /** Readings or verdicts that could not be had, each logged. */
  failed: number
}

type Active = Exclude<SchedulerMode, 'off'>

const log = (event: string, fields: Record<string, unknown>) =>
  console.error(JSON.stringify({ event, ...fields }))

/** A queued run whose issue was read. */
type ReadRun = QueuedRunWithIssue & { issue: { read: true } }

const isRead = (run: QueuedRunWithIssue): run is ReadRun => run.issue.read

/** Has the judge read the issue and records its verdict; a judge that throws records nothing and is logged. */
async function judge(
  deps: SchedulerDeps,
  run: ReadRun,
  head: string,
  mode: Active,
): Promise<ReadinessRecord | undefined> {
  const { title, body } = run.issue.value
  let answer: { response: string; cost: number }
  try {
    answer = await deps.judge(
      readinessMessage({ repository: run.repository, issueNumber: run.issueNumber, title, body }),
    )
  } catch (error) {
    log('schedule_judge_failed', { taskId: run.taskId, error: errorMessage(error) })
    return undefined
  }
  const readiness = parseReadiness(answer.response)
  const detail = { ...readiness, costUsd: answer.cost }
  const id = await recordDecision(deps.db, {
    taskId: run.taskId,
    kind: 'readiness',
    mode,
    head,
    detail,
  })
  return id === undefined ? undefined : { ...readiness, id }
}

/**
 * Holds back a blocked task whose blockers are issues, once a read of GitHub says one is still open. When
 * none is, there is nothing to wait for and the run goes on; a read that fails holds nothing and is logged.
 */
async function blockedByIssues(
  deps: SchedulerDeps,
  run: ReadRun,
  verdict: ReadinessRecord,
): Promise<boolean> {
  const refs = (verdict.blockedBy ?? []).flatMap((n) => {
    const ref = refOf(n)
    return ref ? [ref] : []
  })
  try {
    const open = await openAmong(deps, run.repository, refs)
    if (open.length === 0) return false
    const held = await blockTask(
      deps,
      run,
      open.map((r) => `${r.repository}#${r.number}`),
    )
    if (!held.blocked) log('schedule_not_blocked', { taskId: run.taskId, reason: held.reason })
    return held.blocked
  } catch (error) {
    log('schedule_block_failed', { taskId: run.taskId, error: errorMessage(error) })
    return false
  }
}

/** Judges one queued issue when its current body was not judged, and asks the owner in `auto` when needed. */
async function readinessOf(
  deps: SchedulerDeps,
  run: ReadRun,
  recorded: Map<string, ReadinessRecord>,
  mode: Active,
  result: ScheduleResult,
): Promise<boolean> {
  const head = bodyHash(run.issue.value.title, run.issue.value.body)
  let verdict = recorded.get(readinessKey(run.taskId, head))
  if (readinessStep(verdict, mode) === 'judge') {
    verdict = await judge(deps, run, head, mode)
    if (!verdict) {
      result.failed += 1
      return false
    }
    result.judged += 1
  }
  const step = readinessStep(verdict, mode)
  if (step === 'block') return blockedByIssues(deps, run, verdict!)
  if (step !== 'ask') return false
  const asked = await askOwner(deps, run, verdict!, verdict!.id)
  if (!asked.asked) log('schedule_not_asked', { taskId: run.taskId, reason: asked.reason })
  return asked.asked
}

/** The readiness step: the tasks held back for the owner in this pass. */
async function readinessPass(
  deps: SchedulerDeps,
  runs: ReadRun[],
  mode: Active,
  result: ScheduleResult,
): Promise<Set<number>> {
  const candidates = runs.filter((r) => r.movable && r.firstRun)
  const recorded = await readRecordedReadiness(
    deps.db,
    candidates.map((r) => r.taskId),
  )
  const held = new Set<number>()
  for (const run of candidates) {
    if (await readinessOf(deps, run, recorded, mode, result)) held.add(run.taskId)
  }
  result.asked = held.size
  return held
}

/** The queued runs the order may move, with what their issues say about their place. */
export function entriesOf(runs: ReadRun[]): QueuedEntry[] {
  const unblocks = unblocksOf(runs.map((r) => ({ ...r, body: r.issue.value.body })))
  return runs
    .filter((r) => r.movable)
    .map((r) => ({
      jobId: r.jobId,
      taskId: r.taskId,
      repository: r.repository,
      issueNumber: r.issueNumber,
      priority: priorityOf(r.issue.value.labels),
      bug: isBug(r.issue.value.labels),
      unblocks: unblocks.get(r.taskId) ?? 0,
      continues: !r.firstRun,
      queuedAt: r.queuedAt,
      availableAt: r.availableAt,
    }))
}

const orderDetail = (p: Placement, applied: boolean) => ({
  position: p.position,
  from: p.from.toISOString(),
  to: p.to.toISOString(),
  moved: p.moved,
  applied,
  priority: p.entry.priority,
  bug: p.entry.bug,
  unblocks: p.entry.unblocks,
})

/** The order step: the runs sorted, the moved ones written in `auto`, and each new place recorded. */
async function orderPass(
  deps: SchedulerDeps,
  runs: ReadRun[],
  mode: Active,
  result: ScheduleResult,
): Promise<void> {
  const placements = planOrder(entriesOf(runs))
  const last = await readRecordedOrders(
    deps.db,
    placements.map((p) => p.entry.taskId),
  )
  const written =
    mode === 'auto'
      ? await applyOrder(
          deps.db,
          placements.filter((p) => p.moved),
        )
      : new Set()
  result.moved = written.size
  for (const p of orderToRecord(placements, last, mode)) {
    await recordDecision(deps.db, {
      taskId: p.entry.taskId,
      kind: 'order',
      mode,
      head: orderHead(p),
      detail: orderDetail(p, written.has(p.entry.jobId)),
    })
    result.recorded += 1
  }
}

/**
 * One pass: readiness for the newly queued issues, then the order of what stays queued, each step in its own
 * mode. A step that is `off` does nothing; both off read nothing.
 */
export async function schedule(
  deps: SchedulerDeps,
  modes: SchedulerModes,
): Promise<ScheduleResult> {
  const result: ScheduleResult = { judged: 0, asked: 0, recorded: 0, moved: 0, failed: 0 }
  if (passIsOff(modes)) return result
  const queue = await readQueue(deps)
  for (const run of queue.filter((r) => !r.issue.read)) {
    log('schedule_issue_unread', { taskId: run.taskId, issue: run.issue })
    result.failed += 1
  }
  const runs = queue.filter(isRead)
  const held =
    modes.readiness === 'off'
      ? new Set<number>()
      : await readinessPass(deps, runs, modes.readiness, result)
  if (modes.order === 'off') return result
  await orderPass(
    deps,
    runs.filter((r) => !held.has(r.taskId)),
    modes.order,
    result,
  )
  return result
}

/** The lock that keeps two passes of the scheduler from running at once, on any process. */
const PASS_LOCK = 'schedule'

/**
 * Runs `work` only when no other pass holds the scheduler's lock, which it holds on one connection of the
 * pool for the whole pass. Returns undefined when another pass is running.
 */
export async function alone<T>(
  pool: Pick<Pool, 'connect'>,
  work: () => Promise<T>,
): Promise<T | undefined> {
  const client = await pool.connect()
  try {
    const taken = await client.query<{ taken: boolean }>(
      'select pg_try_advisory_lock(hashtext($1)) as taken',
      [PASS_LOCK],
    )
    if (!taken.rows[0]?.taken) return undefined
    try {
      return await work()
    } finally {
      await client.query('select pg_advisory_unlock(hashtext($1))', [PASS_LOCK])
    }
  } finally {
    client.release()
  }
}

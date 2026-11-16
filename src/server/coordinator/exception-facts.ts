import { and, desc, inArray, isNotNull, isNull, or } from 'drizzle-orm'

import type { Database } from '../db'
import { coordinatorAction, finding, stageEvent, task } from '../db/schema'
import { readOf, unread, type Read } from '../factory/doctor'
import { automaticRunsSincePerson } from '../panel/queries'

import type { RecordedAction } from './decide'
import type { LastEvent, OpenFinding, TaskFacts } from './exceptions'

/**
 * What the coordinator reads before it decides anything, and nothing else: the tasks with an exception to
 * look at, their last events, their automatic runs, the supervisor's open findings about their runs and the
 * decisions already recorded for them. It decides nothing (`exceptions.ts` does). A read of the tasks, the
 * findings or the record that fails is thrown, because without them there is nothing to decide over; a read
 * of what each task says that fails is handed over as not read, and becomes an `unknown` exception.
 */

/** The findings about a run of a task: the ones the panel retries from. */
const RUN_SUBJECTS = ['run', 'queued_run'] as const

async function openFindings(db: Database) {
  return db
    .select({ id: finding.id, kind: finding.kind, taskId: finding.taskId, detail: finding.detail })
    .from(finding)
    .where(
      and(
        isNull(finding.resolvedAt),
        isNotNull(finding.taskId),
        inArray(finding.subject, [...RUN_SUBJECTS]),
      ),
    )
    .orderBy(finding.id)
}

/** A read of one fact for every task, or the reason it could not be read, for each of them. */
async function readEach<T>(tried: string, read: () => Promise<Map<number, T>>) {
  try {
    const values = await read()
    return (taskId: number, absent: T): Read<T> => readOf(values.get(taskId) ?? absent)
  } catch (error) {
    const failed = unread(tried, error instanceof Error ? error.message : String(error))
    return (): Read<T> => failed
  }
}

async function lastEvents(db: Database, ids: number[]) {
  const rows = await db
    .selectDistinctOn([stageEvent.taskId], {
      taskId: stageEvent.taskId,
      stage: stageEvent.stage,
      detail: stageEvent.detail,
    })
    .from(stageEvent)
    .where(inArray(stageEvent.taskId, ids))
    .orderBy(stageEvent.taskId, desc(stageEvent.id))
  return new Map<number, LastEvent | null>(
    rows.map((r) => [
      r.taskId,
      { stage: r.stage, detail: (r.detail ?? null) as Record<string, unknown> | null },
    ]),
  )
}

async function automaticRuns(db: Database, ids: number[]) {
  const rows = await db
    .select({ taskId: stageEvent.taskId, automatic: automaticRunsSincePerson() })
    .from(stageEvent)
    .where(inArray(stageEvent.taskId, ids))
    .groupBy(stageEvent.taskId)
  return new Map(rows.map((r) => [r.taskId, Number(r.automatic)]))
}

/** The facts of every task in `handoff` or `failed`, and of every task with an open finding about its run. */
export async function readExceptionFacts(db: Database): Promise<TaskFacts[]> {
  const found = await openFindings(db)
  const flagged = found.map((f) => f.taskId!)
  const rows = await db
    .select({ id: task.id, stage: task.stage, headSha: task.headSha })
    .from(task)
    .where(or(inArray(task.stage, ['handoff', 'failed']), inArray(task.id, flagged)))
    .orderBy(task.id)
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  const last = await readEach('the last events of the tasks', () => lastEvents(db, ids))
  const runs = await readEach('the automatic runs of the tasks', () => automaticRuns(db, ids))
  return rows.map((r) => ({
    taskId: r.id,
    stage: r.stage,
    headSha: r.headSha,
    last: last(r.id, null),
    automaticRuns: runs(r.id, 0),
    findings: found
      .filter((f) => f.taskId === r.id)
      .map((f): OpenFinding => ({ id: f.id, kind: f.kind, detail: f.detail })),
  }))
}

/** The decisions the coordinator recorded for these tasks, by task. */
export async function readRecordedActions(
  db: Database,
  taskIds: number[],
): Promise<Map<number, RecordedAction[]>> {
  const byTask = new Map<number, RecordedAction[]>(taskIds.map((id) => [id, []]))
  if (taskIds.length === 0) return byTask
  const rows = await db
    .select({
      taskId: coordinatorAction.taskId,
      exceptionKind: coordinatorAction.exceptionKind,
      headSha: coordinatorAction.headSha,
      action: coordinatorAction.action,
      outcome: coordinatorAction.outcome,
    })
    .from(coordinatorAction)
    .where(inArray(coordinatorAction.taskId, taskIds))
    .orderBy(coordinatorAction.id)
  for (const { taskId, ...row } of rows) byTask.get(taskId)?.push(row)
  return byTask
}

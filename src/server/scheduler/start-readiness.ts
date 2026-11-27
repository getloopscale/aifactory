import { eq } from 'drizzle-orm'

import { task } from '../db/schema'
import { errorMessage } from '../factory/error-message'
import { createIssuesApi } from '../github/issues-api'
import { fetchIssue } from '../github/issues'
import { actionDeps } from '../panel/deps'

import { modelAcceptanceDrafter, modelReadinessJudge } from './judge'
import { readinessModeFromEnv, type SchedulerMode } from './mode'
import { readinessOfHeldRun, type JudgedRun, type SchedulerDeps } from './schedule'

/**
 * The readiness of a first run, asked by the worker that took its job, before any sandbox starts (#706). The
 * `schedule` cron judges only runs still queued when it passes, and a free worker takes a new task's run a second
 * or two after it is queued, so without this an issue that arrives while the line is idle is never judged. The
 * verdict and the holds are the cron's own (`readinessOfHeldRun`): one verdict per task and version of the issue,
 * whichever records it first. Anything that fails here lets the run start, logged, as an answer nobody could read
 * does.
 */

/** What a `run-task` job carries that says it continues a task; the facts' `first_run` reads the same keys. */
export type RunInput = {
  decisionId?: number
  feedback?: string
  resume?: boolean
  mergeBase?: boolean
  conversation?: boolean
}

/** A task's first run: nothing was sent back, resumed, merged into it or written to its agent. */
export const isFirstRun = (input: RunInput): boolean =>
  input.decisionId === undefined &&
  input.feedback === undefined &&
  !input.resume &&
  !input.mergeBase &&
  !input.conversation

export type StartReadinessDeps = Pick<SchedulerDeps, 'db' | 'github' | 'readIssue'> & {
  /** Judges and holds one run; `readinessOfHeldRun` with the scheduler's dependencies. */
  holds: (run: JudgedRun & { jobId: null }, mode: Exclude<SchedulerMode, 'off'>) => Promise<boolean>
}

const log = (event: string, fields: Record<string, unknown>) =>
  console.error(JSON.stringify({ event, ...fields }))

/**
 * Whether the run of `taskId` is held back for its issue's readiness: judged now unless a verdict for the issue's
 * current title and body is recorded, and in `auto` held as the cron holds a queued run. `off`, a run that is not
 * a first run, and a task that is not in `intake` are not judged.
 */
export async function heldForReadiness(
  deps: StartReadinessDeps,
  taskId: number,
  input: RunInput,
  mode: SchedulerMode,
): Promise<boolean> {
  if (mode === 'off' || !isFirstRun(input)) return false
  try {
    const [row] = await deps.db
      .select({ repository: task.repository, issueNumber: task.issueNumber, stage: task.stage })
      .from(task)
      .where(eq(task.id, taskId))
    if (!row || row.stage !== 'intake') return false
    const { token } = await deps.github.installationToken(row.repository)
    const issue = await deps.readIssue(row.repository, row.issueNumber, token)
    const run = {
      taskId,
      jobId: null,
      repository: row.repository,
      issueNumber: row.issueNumber,
      issue: { value: issue },
    }
    return await deps.holds(run, mode)
  } catch (error) {
    log('start_readiness_failed', { taskId, error: errorMessage(error) })
    return false
  }
}

/** The scheduler's dependencies for a worker: the issue is read alone, as GitHub holds it now. */
function workerDeps(): SchedulerDeps {
  const { db, github, api } = actionDeps()
  return {
    db,
    github,
    api,
    readIssue: fetchIssue,
    fetchIssue,
    issues: createIssuesApi(),
    judge: modelReadinessJudge(),
    drafter: modelAcceptanceDrafter(),
  }
}

/** `heldForReadiness` in the mode `FACTORY_READINESS_MODE` sets, for the `run-task` job. */
export async function startReadiness(
  taskId: number,
  input: RunInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const mode = readinessModeFromEnv(env)
  if (mode === 'off' || !isFirstRun(input)) return false
  let deps: SchedulerDeps
  try {
    deps = workerDeps()
  } catch (error) {
    log('start_readiness_not_configured', { taskId, error: errorMessage(error) })
    return false
  }
  return heldForReadiness(
    { ...deps, holds: (run, m) => readinessOfHeldRun(deps, run, m) },
    taskId,
    input,
    mode,
  )
}

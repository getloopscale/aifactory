import { and, desc, eq, isNotNull } from 'drizzle-orm'

import type { Database } from '../db'
import { review, stageEvent, task } from '../db/schema'
import type { GithubApp } from '../github/app'
import { autoMergeOrMergeable, type CheckReport, type GithubApi } from '../github/pulls'
import { automaticRunsSincePerson } from '../panel/queries'

import { integrationBranch } from './branches'
import { attachEvidence, type EvidenceApi } from './check-evidence'
import {
  checksFeedback,
  decideWaitingIntegration,
  evidenceOfNote,
  type WaitingStep,
} from './ci-wait'
import { createPreRelease, type ReleaseMode } from './deliver'
import {
  advancePreRelease,
  describeDelivery,
  describeIntegration,
  releaseByMode,
  type Handed,
} from './integration'
import { heldRepositories } from './promotion-merge'
import { loadRepoConfig } from './repo-config'
import { outcome } from './transitions'
import { squashTitle } from './run-support'

export type AwaitCiDeps = {
  db: Database
  github: GithubApp
  api: GithubApi
  /** Reads the log or annotations of a failed check, so the note carries what the sandbox cannot open. */
  checks: EvidenceApi
  /** The factory's release mode, for a repository that sets none. */
  releaseMode: ReleaseMode | undefined
  now?: () => Date
  /** Runs the task again on its branch with the note as feedback (the panel's `sendBackAutomatically`). */
  sendBack: (taskId: number, note: string) => Promise<void>
  /** Runs the task again: on its branch to merge the new base, or from it when the branch is gone (`retryAutomatically`). */
  startOver: (taskId: number) => Promise<void>
}

/** What an integration needs once the merge exists. */
type IntegrationDeps = Pick<AwaitCiDeps, 'db' | 'github' | 'api' | 'releaseMode'>

export type AwaitCiResult = {
  merged: number[]
  sentBack: number[]
  startedOver: number[]
  toPerson: number[]
  waiting: number
  /** Tasks that wait because every failed required check also fails on the integration branch. */
  waitingOnBase: number[]
  /** What stopped a task on this pass; it is looked at again on the next one. */
  errors: string[]
  /** Failed checks whose evidence GitHub would not give: the work went back with their links only. */
  unreadEvidence: string[]
}

type Waiting = {
  row: typeof task.$inferSelect
  verifiedSha: string
  number: number
  token: string
  /** The detail of the `done` stage the run ended with: what the pre-release needs. */
  done: Record<string, unknown>
}

const pullNumber = (url: string | null): number => {
  const found = /\/pull\/(\d+)$/.exec(url ?? '')
  if (!found) throw new Error(`the task has no pull request to wait on: ${url ?? 'none'}`)
  return Number(found[1])
}

/**
 * GitHub merged the verified commit: the integration finishes as a direct merge does, from the same code.
 * The task is claimed by clearing its wait, so a second pass that sees the same merge does nothing.
 */
async function finish(deps: AwaitCiDeps, w: Waiting, mergedSha: string): Promise<boolean> {
  const { row, verifiedSha } = w
  const claimed = await deps.db
    .update(task)
    .set({ mergedSha, awaitingCiSha: null, integrationHeld: false })
    .where(and(eq(task.id, row.id), eq(task.awaitingCiSha, verifiedSha)))
    .returning({ id: task.id })
  if (claimed.length === 0) return false
  await completeIntegration(deps, w, mergedSha, 'auto-merge')
  return true
}

/** What made the merge: GitHub's auto-merge of the verified commit, or a person merging a handoff's pull request. */
type IntegratedBy = 'auto-merge' | 'person'

/**
 * What follows a merge into the integration branch, once the task is claimed: the branch goes, the pre-release
 * branch advances and the pre-release is made. Only the factory's own merge starts a release by mode; work a
 * person merged waits for the release train, or for a person, like any other integrated work.
 */
async function completeIntegration(
  deps: IntegrationDeps,
  w: Waiting,
  mergedSha: string,
  integratedBy: IntegratedBy,
): Promise<void> {
  const { row, verifiedSha, token } = w
  await deps.api.deleteBranch(row.repository, token, `factory/${row.issueNumber}`).catch(() => {})
  const repo = await loadRepoConfig(deps.db, row.repository)
  const advanced = await advancePreRelease(deps, {
    repository: row.repository,
    token,
    integration: integrationBranch(repo),
    mergedSha,
  })
  let handed: Handed
  try {
    handed = await createPreRelease(
      { db: deps.db, api: deps.api },
      {
        taskId: row.id,
        repository: row.repository,
        token,
        issueNumber: row.issueNumber,
        title: row.issueTitle,
        sha: verifiedSha,
        tagSha: advanced.developSha ?? mergedSha,
        pullRequestUrl: row.pullRequestUrl ?? undefined,
        attempts: Number(w.done.attempts ?? 1),
        costUsd: row.costUsd,
        agentSummary: String(w.done.agentSummary ?? ''),
      },
    )
  } catch (error) {
    handed = { error: error instanceof Error ? error.message : String(error) }
  }
  await deps.db.insert(stageEvent).values({
    taskId: row.id,
    stage: 'done',
    detail: {
      sha: verifiedSha,
      pullRequestUrl: row.pullRequestUrl,
      integratedBy,
      ...describeIntegration({ mergedSha, ...advanced }),
      ...describeDelivery(handed),
    },
  })
  // A release follows only a delivery that was made, as after a direct merge.
  if ('tag' in handed && integratedBy === 'auto-merge') {
    const [reviewed] = await deps.db
      .select({ reviewer: review.reviewer })
      .from(review)
      .where(eq(review.taskId, row.id))
      .orderBy(desc(review.id))
      .limit(1)
    await releaseByMode(
      { db: deps.db, github: deps.github, api: deps.api },
      {
        taskId: row.id,
        sha: verifiedSha,
        mode: repo.releaseMode ?? deps.releaseMode,
        actor: `agent:${reviewed?.reviewer ?? 'reviewer'}`,
      },
    )
  }
}

/** The work goes to a person: the pull request stays as it is, and the issue says why. */
async function toPerson(
  deps: AwaitCiDeps,
  w: Waiting,
  step: Extract<WaitingStep, { kind: 'person' }>,
): Promise<boolean> {
  const { row, verifiedSha, token, number } = w
  if (step.stopAutoMerge) await deps.api.disableAutoMerge(row.repository, token, number)
  const moved = await deps.db.transaction(async (tx) => {
    const claimed = await tx
      .update(task)
      .set({ stage: 'handoff', awaitingCiSha: null, integrationHeld: false })
      .where(and(eq(task.id, row.id), eq(task.awaitingCiSha, verifiedSha)))
      .returning({ id: task.id })
    if (claimed.length === 0) return false
    await tx.insert(stageEvent).values({
      taskId: row.id,
      stage: 'handoff',
      detail: {
        reason: step.reason,
        sha: verifiedSha,
        pullRequestUrl: row.pullRequestUrl,
        costUsd: row.costUsd,
      },
    })
    return true
  })
  if (!moved) return false
  await deps.api.commentOnIssue(
    row.repository,
    token,
    row.issueNumber,
    `The factory could not integrate this: ${step.reason}.\n\nIts work is in ${row.pullRequestUrl}, which stays open for a person.`,
  )
  return true
}

/**
 * What a failed required check says: the note with what the log says and the step that exited. Reading the
 * evidence never fails the pass; a log that could not be read is reported and the note says so.
 */
async function readFailure(
  deps: AwaitCiDeps,
  w: Waiting,
  reports: CheckReport[],
  result: AwaitCiResult,
): Promise<string> {
  const { row, token, verifiedSha } = w
  const failed = await attachEvidence(deps.checks, row.repository, token, verifiedSha, reports)
  for (const check of failed) {
    if (check.evidence && 'unreadable' in check.evidence) {
      result.unreadEvidence.push(`task ${row.id}: ${check.name}: ${check.evidence.unreadable}`)
    }
  }
  return checksFeedback(verifiedSha, failed)
}

/**
 * The hold ended on an integration a promotion held out: it is integrated now, as the run would have done.
 * An integration branch that requires checks gets auto-merge pinned to the verified commit, and the task waits
 * for them like any other; otherwise, or when GitHub finds the pull request clean, it is merged pinned to the
 * same commit and finished.
 */
async function integrateHeld(deps: AwaitCiDeps, w: Waiting, required: string[]): Promise<boolean> {
  const { row, verifiedSha, token, number } = w
  const pull = { repo: row.repository, token, number, sha: verifiedSha }
  if (required.length > 0 && (await autoMergeOrMergeable(deps.api, pull)) === 'waiting') {
    await deps.db
      .update(task)
      .set({ integrationHeld: false })
      .where(and(eq(task.id, row.id), eq(task.awaitingCiSha, verifiedSha)))
    return false
  }
  const merged = await deps.api.mergePullRequest(row.repository, token, number, verifiedSha, {
    method: 'squash',
    title: squashTitle(row.issueTitle, row.issueNumber),
  })
  return finish(deps, w, merged.sha)
}

/**
 * What the integration branch's head reports, read only when a check failed on the pull request. A read that
 * fails is no answer: the task is then judged on its own checks, as before.
 */
async function readBase(
  deps: AwaitCiDeps,
  repository: string,
  token: string,
  branch: string,
  reports: CheckReport[],
): Promise<CheckReport[] | undefined> {
  if (!reports.some((r) => r.state === 'failure')) return undefined
  try {
    const head = await deps.api.branchHead(repository, token, branch)
    return head ? await deps.api.checkReports(repository, token, head) : undefined
  } catch {
    return undefined
  }
}

async function look(
  deps: AwaitCiDeps,
  row: typeof task.$inferSelect,
  result: AwaitCiResult,
  holding: Set<string>,
) {
  const verifiedSha = row.awaitingCiSha!
  const [done] = await deps.db
    .select({ detail: stageEvent.detail, at: stageEvent.at })
    .from(stageEvent)
    .where(and(eq(stageEvent.taskId, row.id), eq(stageEvent.stage, 'done')))
    .orderBy(desc(stageEvent.id))
    .limit(1)
  const [runs] = await deps.db
    .select({ automatic: automaticRunsSincePerson() })
    .from(stageEvent)
    .where(eq(stageEvent.taskId, row.id))
    .groupBy(stageEvent.taskId)
  const number = pullNumber(row.pullRequestUrl)
  const { token } = await deps.github.installationToken(row.repository)
  const repo = await loadRepoConfig(deps.db, row.repository)
  const pull = await deps.api.readPullRequest(row.repository, token, number)
  const required = await deps.api.requiredChecks(row.repository, token, integrationBranch(repo))
  const reports = await deps.api.checkReports(row.repository, token, verifiedSha)
  const step = decideWaitingIntegration({
    verifiedSha,
    pull,
    required,
    reports,
    baseReports: await readBase(deps, row.repository, token, integrationBranch(repo), reports),
    waitedMs:
      (deps.now?.() ?? new Date()).getTime() - new Date(done?.at ?? row.createdAt).getTime(),
    automaticRuns: Number(runs?.automatic ?? 0),
    ...(row.integrationHeld
      ? { held: holding.has(row.repository) ? ('holding' as const) : ('released' as const) }
      : {}),
  })
  const w: Waiting = {
    row,
    verifiedSha,
    number,
    token,
    done: (done?.detail ?? {}) as Record<string, unknown>,
  }
  switch (step.kind) {
    case 'wait':
      result.waiting += 1
      if (step.baseRed) result.waitingOnBase.push(row.id)
      return
    case 'finish':
      if (await finish(deps, w, step.mergedSha)) result.merged.push(row.id)
      return
    case 'integrate':
      if (await integrateHeld(deps, w, required)) result.merged.push(row.id)
      else result.waiting += 1
      return
    case 'send_back': {
      const note = await readFailure(deps, w, step.reports, result)
      // Off first: the new commit the agent pushes must not merge before the factory verifies it.
      await deps.api.disableAutoMerge(row.repository, token, number)
      await deps.sendBack(row.id, note)
      result.sentBack.push(row.id)
      return
    }
    case 'start_over':
      // Off first: the run merges the base into this pull request, and that merge must be verified before it lands.
      await deps.api.disableAutoMerge(row.repository, token, number)
      await deps.startOver(row.id)
      result.startedOver.push(row.id)
      return
    case 'person': {
      let said = step
      if (step.reports) {
        // Checks that still fail get the same evidence before a person is told.
        const note = await readFailure(deps, w, step.reports, result)
        said = { ...step, reason: `${step.reason}\n\n${evidenceOfNote(note)}`.slice(0, 3_000) }
      }
      if (await toPerson(deps, w, said)) result.toPerson.push(row.id)
    }
  }
}

/**
 * Looks at every task whose pull request waits for the integration branch's required checks, and takes
 * each one step further: see `decideWaitingIntegration`. A task that cannot be looked at (GitHub failed) is
 * recorded and looked at again on the next pass.
 */
export async function pollAwaitingIntegrations(deps: AwaitCiDeps): Promise<AwaitCiResult> {
  const result: AwaitCiResult = {
    merged: [],
    sentBack: [],
    startedOver: [],
    toPerson: [],
    waiting: 0,
    waitingOnBase: [],
    errors: [],
    unreadEvidence: [],
  }
  const rows = await deps.db
    .select()
    .from(task)
    .where(and(eq(task.stage, 'done'), isNotNull(task.awaitingCiSha)))
    .orderBy(task.id)
  // Read once, so the integrations held out of one promotion all go in together once its hold ends, though
  // the first of them pins the promotion again and starts a new hold.
  const holding = await heldRepositories(deps.db, deps.now?.() ?? new Date())
  for (const row of rows) {
    try {
      await look(deps, row, result, holding)
    } catch (error) {
      result.errors.push(
        `task ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return result
}

export type AdoptResult = {
  adopted: number[]
  /** What stopped a task on this pass; it is looked at again on the next one. */
  errors: string[]
}

/**
 * A person merged the pull request a handoff left, as the owner does with work the factory holds for them
 * (paulohenriquevn/aifactory#139): the task is integrated from that merge as from the factory's own, so the
 * pre-release is made and a release ships it and closes its issue. Nothing is merged here.
 */
export async function adoptMergedHandoffs(deps: IntegrationDeps): Promise<AdoptResult> {
  const result: AdoptResult = { adopted: [], errors: [] }
  const rows = await deps.db
    .select()
    .from(task)
    .where(and(eq(task.stage, 'handoff'), isNotNull(task.pullRequestUrl)))
    .orderBy(task.id)
  for (const row of rows) {
    try {
      if (await adopt(deps, row)) result.adopted.push(row.id)
    } catch (error) {
      result.errors.push(
        `task ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return result
}

async function adopt(deps: IntegrationDeps, row: typeof task.$inferSelect): Promise<boolean> {
  if (outcome(row, 'merged_by_person').kind !== 'action') return false
  const number = pullNumber(row.pullRequestUrl)
  const { token } = await deps.github.installationToken(row.repository)
  const pull = await deps.api.readPullRequest(row.repository, token, number)
  if (!pull.merged || !pull.mergeCommitSha) return false
  const [handed] = await deps.db
    .select({ detail: stageEvent.detail })
    .from(stageEvent)
    .where(and(eq(stageEvent.taskId, row.id), eq(stageEvent.stage, 'handoff')))
    .orderBy(desc(stageEvent.id))
    .limit(1)
  // Claimed by its stage, so a second pass that sees the same merge does nothing.
  const claimed = await deps.db
    .update(task)
    .set({ stage: 'done', mergedSha: pull.mergeCommitSha })
    .where(and(eq(task.id, row.id), eq(task.stage, 'handoff')))
    .returning({ id: task.id })
  if (claimed.length === 0) return false
  const w: Waiting = {
    row,
    verifiedSha: pull.headSha,
    number,
    token,
    done: (handed?.detail ?? {}) as Record<string, unknown>,
  }
  await completeIntegration(deps, w, pull.mergeCommitSha, 'person')
  return true
}

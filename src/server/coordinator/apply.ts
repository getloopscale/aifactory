import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'

import type { Database } from '../db'
import { coordinatorAction, repository, task } from '../db/schema'
import { release, ReleaseRefused } from '../factory/deliver'
import { outcome as transition } from '../factory/transitions'
import type { Issue } from '../github/issues'
import type { IssuesApi } from '../github/issues-api'
import {
  ActionRefused,
  mergeBaseByCoordinator,
  resolveFinding,
  sendBackByCoordinator,
  type ActionDeps,
} from '../panel/actions'
import { FACTORY_LABEL, FACTORY_LABEL_SPEC } from '../panel/work'

import { baseFixIssue, baseSignature } from './base-fix'
import type { CoordinatorOutcome, Decision } from './decide'
import type { ReadIssue } from './draft'
import type { RedBase, TaskException } from './exceptions'
import { fileOnce } from './file-once'
import type { CoordinatorMode } from './mode'
import { HOLD_LOCK, moveAhead } from './queue-apply'
import { readHeldTests } from './queue-facts'
import { COORDINATOR_ACTOR } from './release-train'
import {
  followUpIssue,
  followUpOrigin,
  gapIssue,
  gapNote,
  gapTargetAllowed,
  sameGap,
  infeasibleNamed,
  qualityConfigurationNamed,
  sameFollowUp,
  scopeSection,
  type ScopeDraft,
} from './scope'

/**
 * The only module of the coordinator with side effects. It applies a decision through the panel's own
 * actions, each of which asks `factory/transitions.ts` first, and records it in `coordinator_action`,
 * applied or not. Its only writes of its own are on GitHub: the issue body and the follow-up issue a `scope`
 * needs, and the issue a `fix_base` files on a repository whose integration branch is red, which changes no
 * task. It merges nothing itself: a release goes through `release()` and every refusal of it.
 */

export type ApplyDeps = ActionDeps & {
  issues: Pick<IssuesApi, 'createIssue' | 'updateIssueBody' | 'ensureLabel'>
  readIssue: ReadIssue
  /** The open issues of a repository that carry a label, as `listOpenIssues` reads them: where a follow-up is looked for. */
  listOpenIssues: (repo: string, label: string | null, token: string) => Promise<Issue[]>
  /** The clock a decision is recorded at, which is what the age of a `wait` is measured against. */
  now?: () => Date
}

/** The labels of the fix of a red base: the factory builds it, and its queue takes it first. */
const BASE_FIX_LABELS = [
  FACTORY_LABEL_SPEC,
  { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  { name: 'priority:1', color: 'b60205', description: 'The factory takes this issue first' },
]

/** Whether the owner enabled the repository, which is what lets the `factory` label make a task of an issue. */
async function enabled(deps: ApplyDeps, fullName: string): Promise<boolean> {
  const [repo] = await deps.db
    .select({ enabled: repository.enabled })
    .from(repository)
    .where(eq(repository.fullName, fullName))
  return repo?.enabled ?? false
}

type TaskRow = typeof task.$inferSelect

/** Every follow-up a scope files carries it, so a person finds them, and so does the next scope looking for one. */
export const FOLLOW_UP_LABEL_SPEC = {
  name: 'follow-up',
  color: 'c5def5',
  description: 'Work a scope decision of the factory left out of another issue',
}

/** The follow-up an earlier scope of the task filed, if one did. */
async function followUpOfTask(deps: ApplyDeps, taskId: number): Promise<number | undefined> {
  const [row] = await deps.db
    .select({ number: sql<number>`(${coordinatorAction.draft}->>'followUpIssue')::int` })
    .from(coordinatorAction)
    .where(
      and(
        eq(coordinatorAction.taskId, taskId),
        eq(coordinatorAction.outcome, 'applied'),
        isNotNull(sql`${coordinatorAction.draft}->>'followUpIssue'`),
      ),
    )
    .orderBy(desc(coordinatorAction.id))
    .limit(1)
  return row?.number ?? undefined
}

/** An open issue of the repository that already is this follow-up: one filed for the same issue, or with its title. */
async function openFollowUp(deps: ApplyDeps, row: TaskRow, token: string, title: string) {
  for (const label of [FOLLOW_UP_LABEL_SPEC.name, FACTORY_LABEL]) {
    const open = await deps.listOpenIssues(row.repository, label, token)
    const same = open.find(
      (i) =>
        i.number !== row.issueNumber && sameFollowUp(i, row.repository, row.issueNumber, title),
    )
    if (same) return same.number
  }
  return undefined
}

/**
 * The follow-up the draft files, once per task: a second scope of the task names the one the first filed, and an
 * open issue that already is the follow-up is named instead of filing another. It is labelled for the factory
 * only in a repository the owner enabled, and only when the issue is not a follow-up itself: a follow-up of a
 * follow-up is for a person to triage, so no chain of them grows on its own.
 */
async function fileFollowUp(
  deps: ApplyDeps,
  row: TaskRow,
  token: string,
  draft: ScopeDraft,
  body: string,
) {
  const issue = followUpIssue(draft, row.repository, row.issueNumber)
  if (!issue) return null
  const earlier =
    (await followUpOfTask(deps, row.id)) ?? (await openFollowUp(deps, row, token, issue.title))
  if (earlier !== undefined) return earlier
  const forFactory = (await enabled(deps, row.repository)) && !followUpOrigin(body)
  await deps.issues.ensureLabel(row.repository, token, FOLLOW_UP_LABEL_SPEC)
  const labels = [...(forFactory ? [FACTORY_LABEL] : []), FOLLOW_UP_LABEL_SPEC.name]
  return (await deps.issues.createIssue(row.repository, token, { ...issue, labels })).number
}

/**
 * Files the framework gap issue a review asked the builder for, in the repository the draft names and with that
 * repository's own token, then sends the task back naming it. An open issue with the same title is named instead of
 * filing another. Never falls back to another repository: a refusal is a failure the row records.
 */
async function fileGap(deps: ApplyDeps, row: TaskRow, draft: ScopeDraft): Promise<Performed> {
  const issue = gapIssue(draft, row.repository, row.issueNumber)!
  const allowed = gapTargetAllowed(draft, row.repository, await enabled(deps, issue.repository))
  if (!allowed) {
    throw new ActionRefused(
      `${issue.repository} is neither the task's repository nor one the owner enabled`,
    )
  }
  const { token } = await deps.github.installationToken(issue.repository)
  const earlier = await gapOfTask(deps, row.id, issue.repository)
  const number =
    earlier ??
    (await deps.listOpenIssues(issue.repository, null, token)).find((i) => sameGap(i, issue.title))
      ?.number ??
    (
      await deps.issues.createIssue(issue.repository, token, {
        title: issue.title,
        body: issue.body,
      })
    ).number
  const reference = `${issue.repository}#${number}`
  try {
    await sendBackByCoordinator(deps, row.id, gapNote(draft, reference), { fromReview: true })
  } catch (error) {
    throw new GapFiled(reference, error)
  }
  return { done: `filed the gap issue ${reference}`, gapIssue: reference }
}

/** A send-back that failed after the gap issue existed: the row keeps the reference, so a retry reuses it. */
class GapFiled extends Error {
  constructor(
    readonly reference: string,
    readonly original: unknown,
  ) {
    super(original instanceof Error ? original.message : String(original))
  }
}

/** The gap issue an earlier decision of the task filed or found in the repository, as `owner/name#N`'s number. */
async function gapOfTask(
  deps: ApplyDeps,
  taskId: number,
  repo: string,
): Promise<number | undefined> {
  const rows = await deps.db
    .select({ reference: sql<string>`${coordinatorAction.draft}->>'gapIssue'` })
    .from(coordinatorAction)
    .where(
      and(
        eq(coordinatorAction.taskId, taskId),
        isNotNull(sql`${coordinatorAction.draft}->>'gapIssue'`),
      ),
    )
    .orderBy(desc(coordinatorAction.id))
  const found = rows.map((r) => r.reference).find((r) => r.startsWith(`${repo}#`))
  return found ? Number(found.slice(repo.length + 1)) : undefined
}

/**
 * Scopes the task: asks the transition table before anything reaches GitHub, files the follow-up, appends
 * the decision to the issue body and sends the task back on its branch with the note. Returns the number
 * of the follow-up, or null when the draft filed none.
 */
async function scope(deps: ApplyDeps, taskId: number, draft: ScopeDraft): Promise<Performed> {
  const [row] = await deps.db.select().from(task).where(eq(task.id, taskId))
  if (!row) throw new ActionRefused(`task ${taskId} does not exist`)
  const allowed = transition(row, 'coordinator_send_back')
  if (allowed.kind !== 'action') throw new ActionRefused(allowed.reason)
  const { token } = await deps.github.installationToken(row.repository)
  if (draft.gap) return fileGap(deps, row, draft)
  const { body } = await deps.readIssue(row.repository, row.issueNumber, token)
  const followUp = await fileFollowUp(deps, row, token, draft, body)
  const section = scopeSection(draft, new Date().toISOString().slice(0, 10), followUp ?? undefined)
  const updated = [body.trimEnd(), section].filter((part) => part !== '').join('\n\n')
  await deps.issues.updateIssueBody(row.repository, token, row.issueNumber, updated)
  await sendBackByCoordinator(deps, taskId, draft.note, { fromReview: true })
  return { followUpIssue: followUp }
}

/**
 * Files the fix of a red integration branch, once per repository, branch and set of checks (`fileOnce`): an
 * issue whose earlier one was closed is filed again. Answers what became of it, for the record.
 */
async function fixBase(deps: ApplyDeps, base: RedBase): Promise<string> {
  const repo = base.repository
  const { token } = await deps.github.installationToken(repo)
  const labels = (await enabled(deps, repo)) ? BASE_FIX_LABELS : BASE_FIX_LABELS.slice(1)
  const claim = { signature: baseSignature(base), repository: repo, now: new Date() }
  const done = await fileOnce(
    deps.db,
    claim,
    async (previous) => {
      for (const label of labels) await deps.issues.ensureLabel(repo, token, label)
      const issue = baseFixIssue(base, previous)
      return deps.issues.createIssue(repo, token, { ...issue, labels: labels.map((l) => l.name) })
    },
    async (number) => (await deps.readIssue(repo, number, token)).state === 'closed',
  )
  if ('filed' in done) return `filed as ${repo}#${done.filed.number}`
  return done.already === null
    ? 'another pass is filing it'
    : `already filed as ${repo}#${done.already}, still open`
}

/** What carrying out a decision left: the follow-up a scope filed (null for none), or what a fix became. */
type Performed = { followUpIssue?: number | null; done?: string; gapIssue?: string }

/** Carries out a decision that changes something. Escalating and waiting change nothing, so they never come here. */
async function perform(
  deps: ApplyDeps,
  exception: TaskException,
  decision: Decision,
): Promise<Performed> {
  if (decision.action === 'send_back') {
    await sendBackByCoordinator(deps, exception.taskId, decision.note ?? '')
  } else if (decision.action === 'merge_base') {
    await mergeBaseByCoordinator(deps, exception.taskId, decision.note ?? '')
  } else if (decision.action === 'review_again') {
    await sendBackByCoordinator(deps, exception.taskId, '')
  } else if (decision.action === 'retry_from_finding') {
    await resolveFinding(deps, decision.findingId!, 'retry', { automatic: true })
  } else if (decision.action === 'scope' && decision.draft) {
    return await scope(deps, exception.taskId, decision.draft)
  } else if (decision.action === 'release' && decision.bump) {
    await release(deps, exception.taskId, {
      bump: decision.bump,
      actor: COORDINATOR_ACTOR,
      expectedHead: exception.verifiedHead,
    })
  } else if (decision.action === 'fix_base' && decision.base) {
    return { done: await fixBase(deps, decision.base) }
  } else {
    throw new Error(`the coordinator has no way to apply ${decision.action}`)
  }
  return {}
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

type Carried = {
  outcome: CoordinatorOutcome
  reason: string
  /** The follow-up a scope filed (null for none); absent when nothing was applied. */
  followUpIssue?: number | null
  /** The gap issue a scope filed, as `owner/name#N`, kept even when the send-back after it failed. */
  gapIssue?: string
}

/** A decision that was refused or failed, logged with its context, so a person sees it as well as the next pass. */
function notCarried(
  exception: TaskException,
  decision: Decision,
  outcome: 'refused' | 'failed',
  why: string,
): Carried {
  console.error(
    JSON.stringify({
      event: `coordinator_${outcome}`,
      taskId: exception.taskId,
      exception: exception.kind,
      head: exception.head,
      action: decision.action,
      error: why,
    }),
  )
  return { outcome, reason: `${decision.reason}. It was ${outcome}: ${why}` }
}

/** Why a decision may not be applied at all, whatever the mode, or nothing. */
function forbidden(decision: Decision): string | undefined {
  if (!decision.draft) return undefined
  const named = qualityConfigurationNamed(decision.draft)
  if (named)
    return `the draft names ${named}, and no quality gate is loosened to make a review converge`
  const infeasible = infeasibleNamed(decision.draft)
  return infeasible
    ? `the draft puts in scope ${infeasible}, which the factory cannot do from its sandbox`
    : undefined
}

/** A decision only recorded; the issue a `fix_base` would file is logged too, so its text can be read first. */
function inTrial(exception: TaskException, decision: Decision): Carried {
  if (decision.action === 'fix_base' && decision.base) {
    const { title } = baseFixIssue(decision.base)
    console.log(
      JSON.stringify({
        event: 'coordinator_fix_base_trial',
        taskId: exception.taskId,
        repository: decision.base.repository,
        signature: baseSignature(decision.base),
        title,
      }),
    )
  }
  return { outcome: 'trial', reason: decision.reason }
}

/** What became of the decision, and the reason to record with it. */
async function carryOut(
  deps: ApplyDeps,
  exception: TaskException,
  decision: Decision,
  mode: CoordinatorMode,
): Promise<Carried> {
  if (decision.failure !== undefined) {
    return notCarried(exception, decision, 'failed', decision.failure)
  }
  if (decision.action === 'escalate') return { outcome: 'escalated', reason: decision.reason }
  if (decision.action === 'wait') return { outcome: 'deferred', reason: decision.reason }
  const refusal = forbidden(decision)
  if (refusal) return notCarried(exception, decision, 'refused', refusal)
  if (mode !== 'auto') return inTrial(exception, decision)
  try {
    const { followUpIssue, done, gapIssue } = await perform(deps, exception, decision)
    const reason = done ? `${decision.reason}: ${done}` : decision.reason
    return { outcome: 'applied', reason, followUpIssue, gapIssue }
  } catch (caught) {
    const filed = caught instanceof GapFiled ? caught : undefined
    const error = filed ? filed.original : caught
    const refused = error instanceof ActionRefused || error instanceof ReleaseRefused
    const outcome = refused ? 'refused' : 'failed'
    return {
      ...notCarried(exception, decision, outcome, message(error)),
      gapIssue: filed?.reference,
    }
  }
}

/** What the row keeps of the model's work: the draft with the follow-up it filed, or the unread answer. */
function recordedDraft(decision: Decision, carried: Carried) {
  if (decision.draft) {
    const withGap =
      carried.gapIssue === undefined
        ? decision.draft
        : { ...decision.draft, gapIssue: carried.gapIssue }
    return carried.followUpIssue === undefined
      ? withGap
      : { ...withGap, followUpIssue: carried.followUpIssue }
  }
  return decision.answer === undefined ? null : { answer: decision.answer }
}

/**
 * Applies the decision (or, in `trial`, only records it) and records it once for the exception on its head,
 * with what a model drafted for it and what that cost. A pass that raced another one to the same exception
 * records nothing more.
 */
export async function applyDecision(
  deps: ApplyDeps,
  exception: TaskException,
  decision: Decision,
  mode: CoordinatorMode,
): Promise<CoordinatorOutcome> {
  if (decision.action === 'prioritise' && mode === 'auto' && decision.failure === undefined) {
    return prioritiseAtomically(deps, exception, decision)
  }
  // The first wait says since when the fact is unreadable; the ones after it add nothing to that.
  if (decision.quiet) return 'deferred'
  const carried = await carryOut(deps, exception, decision, mode)
  await record(deps, exception, decision, carried)
  return carried.outcome
}

/**
 * The hold and its record commit together, one pass at a time per repository: another pass never sees the
 * delayed jobs without the applied action (and releases them), nor applies the same decision a second time.
 */
async function prioritiseAtomically(
  deps: ApplyDeps,
  exception: TaskException,
  decision: Decision,
): Promise<CoordinatorOutcome> {
  return deps.db.transaction(async (tx) => {
    await tx.execute(HOLD_LOCK)
    const [done] = await tx
      .select()
      .from(coordinatorAction)
      .where(
        and(
          eq(coordinatorAction.taskId, exception.taskId),
          eq(coordinatorAction.exceptionKind, exception.kind),
          eq(coordinatorAction.headSha, exception.head),
          eq(coordinatorAction.outcome, 'applied'),
        ),
      )
    if (done) return 'applied'
    // One fix at a time per repository: a second one waits for its turn, and is decided again then.
    const [own] = await tx
      .select({ repository: task.repository })
      .from(task)
      .where(eq(task.id, exception.taskId))
    const active = (await readHeldTests(tx)).find(
      (h) => h.repository === own?.repository && h.taskId !== exception.taskId,
    )
    if (active) return 'refused'
    const moved = await moveAhead(tx, exception.taskId)
    const carried: Carried = moved
      ? { outcome: 'applied', reason: decision.reason }
      : notCarried(exception, decision, 'refused', 'its job is no longer waiting in the queue')
    await record({ ...deps, db: tx }, exception, decision, carried)
    return carried.outcome
  })
}

async function record(
  { db, now }: { db: Pick<Database, 'insert'>; now?: () => Date },
  exception: TaskException,
  decision: Decision,
  carried: Carried,
) {
  await db
    .insert(coordinatorAction)
    .values({
      taskId: exception.taskId,
      exceptionKind: exception.kind,
      headSha: exception.head,
      action: decision.action,
      reason: carried.reason,
      outcome: carried.outcome,
      draft: recordedDraft(decision, carried),
      costUsd: decision.costUsd ?? 0,
      at: now?.() ?? new Date(),
    })
    .onConflictDoNothing()
}

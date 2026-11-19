import { and, eq, isNotNull, isNull } from 'drizzle-orm'

import type { Database } from '../db'
import { promotionFinding, task } from '../db/schema'
import type { IssuesApi } from '../github/issues-api'
import type { PromotionApi, PromotionPull } from '../github/promotion-api'
import type { GithubApi } from '../github/pulls'
import { FACTORY_LABEL } from '../ingest/decide'
import type { CoordinatorMode } from '../coordinator/mode'
import { maintainHolds } from '../coordinator/queue-hold'
import { decideLine, MAX_ATTEMPTS, type LineStep } from '../line/decide'
import { openIncident, recordIncident, updateIncident, type Incident } from '../line/incident'

import { findingSignature, togetherBody, togetherTitle, type SeenCheck } from './promotion'

/**
 * The red promotion of the integration branch as a stopped line (`line/decide.ts`): one issue for every
 * failure of the head instead of one per check, kept until the promotion is green. While it is open the queue
 * holds the repository's other runs (`coordinator/queue-hold.ts`) and nothing else of it integrates
 * (`integrationHeldUntil`).
 */

export type LineContext = {
  db: Database
  api: Pick<PromotionApi, 'pendingChecks' | 'issueOpen'>
  github: Pick<GithubApi, 'commentOnIssue' | 'closeIssue'>
  issues: Pick<IssuesApi, 'createIssue' | 'ensureLabel'>
  repo: string
  token: string
  mode: CoordinatorMode
  /** What the pass did, one line each, for its log. */
  done: string[]
}

type Head = { pull: PromotionPull; head: string; base: string }

/** Goes ahead of everything else in the queue, the scheduler's first label. */
const FIRST = {
  name: 'priority:1',
  color: 'b60205',
  description: 'The factory takes this issue first',
}

const at = ({ pull, head, base }: Head) => ({
  pullRequest: { number: pull.number, url: pull.url },
  head,
  base,
  sha: pull.headSha,
})

const STOPPED = (h: Head) =>
  [
    `**The line is stopped.** While this promotion is red no new task of this repository runs and nothing else integrates into \`${h.head}\`, so this issue is the only work the factory does here. Make every check below pass together; the line runs again once the promotion is green.`,
    '',
  ].join('\n')

function fixText(checks: SeenCheck[], h: Head, previous?: Incident) {
  const again = previous
    ? `The last fix, #${previous.issueNumber}, ended and the promotion is still red.\n\n`
    : ''
  return {
    title: togetherTitle(checks, at(h)),
    body: `${STOPPED(h)}${again}${togetherBody(checks, at(h))}`,
  }
}

/** Whether the incident's fix is over: its task integrated, or its issue was closed. */
async function fixEnded(ctx: LineContext, issueNumber: number): Promise<boolean> {
  const [merged] = await ctx.db
    .select({ id: task.id })
    .from(task)
    .where(
      and(
        eq(task.repository, ctx.repo),
        eq(task.issueNumber, issueNumber),
        isNotNull(task.mergedSha),
      ),
    )
  if (merged) return true
  return !(await ctx.api.issueOpen(ctx.repo, ctx.token, issueNumber))
}

async function factoryLabels(ctx: LineContext) {
  await ctx.issues.ensureLabel(ctx.repo, ctx.token, {
    name: FACTORY_LABEL,
    color: '5319e7',
    description: 'The factory builds this issue',
  })
  await ctx.issues.ensureLabel(ctx.repo, ctx.token, FIRST)
  return [FACTORY_LABEL, FIRST.name]
}

/**
 * Points every failure of the head at the incident's issue, so the per-check filing leaves them alone, and
 * closes the per-check issues of the repository whose fix never integrated: the incident does their work.
 */
async function absorb(
  ctx: LineContext,
  checks: SeenCheck[],
  h: Head,
  issue: { number: number; url: string },
) {
  for (const check of checks) {
    const signature = findingSignature(check.name, check.evidence)
    await ctx.db
      .insert(promotionFinding)
      .values({
        repository: ctx.repo,
        checkName: check.name,
        signature,
        forFactory: true,
        lastSha: h.pull.headSha,
        issueNumber: issue.number,
        issueUrl: issue.url,
      })
      .onConflictDoUpdate({
        target: [
          promotionFinding.repository,
          promotionFinding.checkName,
          promotionFinding.signature,
        ],
        set: {
          issueNumber: issue.number,
          issueUrl: issue.url,
          lastSha: h.pull.headSha,
          updatedAt: new Date(),
        },
      })
  }
  const others = await ctx.db
    .selectDistinct({ issueNumber: promotionFinding.issueNumber })
    .from(promotionFinding)
    .leftJoin(
      task,
      and(
        eq(task.repository, promotionFinding.repository),
        eq(task.issueNumber, promotionFinding.issueNumber),
      ),
    )
    .where(
      and(
        eq(promotionFinding.repository, ctx.repo),
        eq(promotionFinding.forFactory, true),
        isNotNull(promotionFinding.issueNumber),
        isNull(task.mergedSha),
      ),
    )
  for (const { issueNumber } of others) {
    if (issueNumber === null || issueNumber === issue.number) continue
    if (!(await ctx.api.issueOpen(ctx.repo, ctx.token, issueNumber))) continue
    await ctx.github.commentOnIssue(
      ctx.repo,
      ctx.token,
      issueNumber,
      `Superseded by #${issue.number}, which fixes every failure of the promotion at once while the line is stopped.`,
    )
    await ctx.github.closeIssue(ctx.repo, ctx.token, issueNumber)
    ctx.done.push(`${ctx.repo}#${issueNumber} superseded by #${issue.number}`)
  }
}

async function open(ctx: LineContext, checks: SeenCheck[], h: Head) {
  const issue = await ctx.issues.createIssue(ctx.repo, ctx.token, {
    ...fixText(checks, h),
    labels: await factoryLabels(ctx),
  })
  const recorded = await recordIncident(ctx.db, {
    repository: ctx.repo,
    cause: 'promotion_red',
    surface: `${h.head} -> ${h.base}`,
    issueNumber: issue.number,
    issueUrl: issue.url,
    lastSha: h.pull.headSha,
  })
  if (!recorded)
    throw new Error(
      `${ctx.repo}: another pass stopped the line first; #${issue.number} is a duplicate`,
    )
  await absorb(ctx, checks, h, issue)
  ctx.done.push(`${ctx.repo}: line stopped, fix ${issue.url}`)
}

async function note(ctx: LineContext, incident: Incident, checks: SeenCheck[], h: Head) {
  await ctx.github.commentOnIssue(
    ctx.repo,
    ctx.token,
    incident.issueNumber,
    `The promotion moved to \`${h.pull.headSha.slice(0, 7)}\` and is still red. What fails there now:\n\n${togetherBody(checks, at(h))}`,
  )
  await updateIncident(ctx.db, incident.id, { lastSha: h.pull.headSha })
  ctx.done.push(`${ctx.repo}#${incident.issueNumber}: noted ${checks.length} failures`)
}

/** A new fix after the last one ended, or, once the fixes ran out, an issue for a person. */
async function refile(
  ctx: LineContext,
  incident: Incident,
  checks: SeenCheck[],
  h: Head,
  person: boolean,
) {
  const text = fixText(checks, h, incident)
  const issue = await ctx.issues.createIssue(ctx.repo, ctx.token, {
    ...text,
    body: person
      ? `${text.body}\n\nThe factory filed ${MAX_ATTEMPTS} fixes for this and the line is still stopped, so a person decides.`
      : text.body,
    labels: person ? [] : await factoryLabels(ctx),
  })
  await updateIncident(ctx.db, incident.id, {
    issueNumber: issue.number,
    issueUrl: issue.url,
    lastSha: h.pull.headSha,
    attempts: incident.attempts + 1,
    ...(person ? { status: 'escalated' as const } : {}),
  })
  await absorb(ctx, checks, h, issue)
  ctx.done.push(`${ctx.repo}: ${person ? 'escalated' : 'new fix'} ${issue.url}`)
}

async function resolve(ctx: LineContext, incident: Incident, h: Head) {
  await updateIncident(ctx.db, incident.id, { status: 'resolved', endedAt: new Date() })
  await ctx.github.commentOnIssue(
    ctx.repo,
    ctx.token,
    incident.issueNumber,
    `The promotion is green at \`${h.pull.headSha.slice(0, 7)}\`: the line runs again.`,
  )
  ctx.done.push(`${ctx.repo}: line runs again`)
}

/**
 * Decides and, in `auto`, applies. True when the line took the failures, so the per-check filing must not:
 * in `auto` with failures or an incident open. `trial` logs what it would do and leaves the filing as it was.
 */
export async function watchLine(ctx: LineContext, checks: SeenCheck[], h: Head): Promise<boolean> {
  if (ctx.mode === 'off') return false
  const incident = await openIncident(ctx.db, ctx.repo)
  const failures = checks.length
  const settled =
    incident !== undefined && failures === 0
      ? (await ctx.api.pendingChecks(ctx.repo, ctx.token, h.pull.headSha)) === 0
      : false
  const ended =
    incident && failures > 0 && h.pull.headSha !== incident.lastSha
      ? await fixEnded(ctx, incident.issueNumber)
      : undefined
  const step: LineStep = decideLine({
    ...(incident ? { incident } : {}),
    head: h.pull.headSha,
    failures,
    settled,
    ...(ended === undefined ? {} : { fixEnded: ended }),
  })
  if (ctx.mode === 'trial') {
    if (step.kind !== 'none') ctx.done.push(`${ctx.repo}: would ${step.kind} (trial)`)
    return false
  }
  if (step.kind === 'open') await open(ctx, checks, h)
  else if (incident && step.kind === 'note') await note(ctx, incident, checks, h)
  else if (incident && step.kind === 'retry') await refile(ctx, incident, checks, h, false)
  else if (incident && step.kind === 'escalate') await refile(ctx, incident, checks, h, true)
  else if (incident && step.kind === 'resolve') await resolve(ctx, incident, h)
  // The queue follows the line at once, not on the coordinator's next pass.
  if (step.kind === 'open' || step.kind === 'resolve') await maintainHolds(ctx.db)
  return incident !== undefined || step.kind === 'open'
}

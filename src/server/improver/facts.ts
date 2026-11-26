import { and, desc, eq, gte, inArray, isNotNull, like, ne, notInArray, or, sql } from 'drizzle-orm'

import type { Database } from '../db'
import {
  failureSignature,
  improverDecision,
  lineIncident,
  repository,
  stageEvent,
  task,
} from '../db/schema'
import { baseHoldOf } from '../factory/await-ci'

import { IMPROVER_KINDS, startOfDay, type ImproverKind, type RepoFacts } from './decide'

/** Reads what `decide.ts` decides over, and decides nothing. A read that fails is a fact that was not read. */

/** The stages in which a task no longer asks for the factory's time. */
const AT_REST = ['done', 'released', 'handoff', 'failed', 'cancelled'] as const

export type IssueReader = (
  repository: string,
  number: number,
) => Promise<{ state?: 'open' | 'closed' }>

const group = <T extends { repository: string }>(rows: T[]) => {
  const by = new Map<string, T[]>()
  for (const row of rows) by.set(row.repository, [...(by.get(row.repository) ?? []), row])
  return by
}

/** Whether the issue the improver filed last for each repository is open. One read per repository, never one per issue. */
async function openIssues(db: Database, repos: string[], read: IssueReader) {
  const rows = await db
    .select({ repository: failureSignature.repository, number: failureSignature.issueNumber })
    .from(failureSignature)
    .where(
      and(
        inArray(failureSignature.repository, repos),
        like(failureSignature.signature, 'improve:%'),
        isNotNull(failureSignature.issueNumber),
      ),
    )
    .orderBy(desc(failureSignature.id))
  const latest = new Map<string, number>()
  for (const row of rows) if (!latest.has(row.repository)) latest.set(row.repository, row.number!)
  const open = new Map<string, RepoFacts['openIssue']>()
  await Promise.all(
    [...latest].map(async ([repo, number]) => {
      try {
        const { state } = await read(repo, number)
        open.set(repo, state === 'closed' ? null : state === 'open' ? { number } : 'unread')
      } catch {
        open.set(repo, 'unread')
      }
    }),
  )
  return open
}

/** The tasks that hold the repository's attention, and the ones a red base holds. */
async function taskFacts(db: Database, repos: string[]) {
  const busy = new Set<string>()
  const baseHeld = new Set<string>()
  const active = await db
    .select({ repository: task.repository })
    .from(task)
    .where(and(inArray(task.repository, repos), notInArray(task.stage, [...AT_REST])))
  for (const row of active) busy.add(row.repository)
  const waiting = await db
    .select({ id: task.id, repository: task.repository, awaitingCiSha: task.awaitingCiSha })
    .from(task)
    .where(
      and(inArray(task.repository, repos), eq(task.stage, 'done'), isNotNull(task.awaitingCiSha)),
    )
  for (const row of waiting) busy.add(row.repository)
  if (waiting.length > 0) {
    const events = await db
      .selectDistinctOn([stageEvent.taskId], {
        taskId: stageEvent.taskId,
        detail: stageEvent.detail,
      })
      .from(stageEvent)
      .where(
        and(
          inArray(
            stageEvent.taskId,
            waiting.map((w) => w.id),
          ),
          eq(stageEvent.stage, 'done'),
        ),
      )
      .orderBy(stageEvent.taskId, desc(stageEvent.id))
    const detail = new Map(events.map((e) => [e.taskId, e.detail]))
    for (const row of waiting) {
      if (baseHoldOf(detail.get(row.id), row.awaitingCiSha)) baseHeld.add(row.repository)
    }
  }
  return { busy, baseHeld }
}

export async function readFacts(
  db: Database,
  now: Date,
  readIssue: IssueReader,
): Promise<RepoFacts[]> {
  const repos = (
    await db
      .select({ name: repository.fullName })
      .from(repository)
      .where(eq(repository.enabled, true))
  ).map((r) => r.name)
  if (repos.length === 0) return []
  const [tasks, issues, lines, scouted, today] = await Promise.all([
    taskFacts(db, repos),
    openIssues(db, repos, readIssue),
    db
      .select({ repository: lineIncident.repository })
      .from(lineIncident)
      .where(
        and(inArray(lineIncident.repository, repos), sql`${lineIncident.status} <> 'resolved'`),
      ),
    db
      .select({
        repository: improverDecision.repository,
        kind: improverDecision.kind,
        at: sql<Date>`max(${improverDecision.createdAt})`.mapWith(
          (v) => new Date(v as string | Date),
        ),
      })
      .from(improverDecision)
      .where(
        and(
          inArray(improverDecision.repository, repos),
          // Any row where a scout ran: a skip of the pass has no signature, one after a scout does.
          or(ne(improverDecision.outcome, 'skipped'), isNotNull(improverDecision.signature)),
        ),
      )
      .groupBy(improverDecision.repository, improverDecision.kind),
    db
      .select({ repository: improverDecision.repository })
      .from(improverDecision)
      .where(
        and(
          inArray(improverDecision.repository, repos),
          eq(improverDecision.outcome, 'proposed'),
          gte(improverDecision.createdAt, startOfDay(now)),
        ),
      ),
  ])
  const stopped = new Set(lines.map((l) => l.repository))
  const proposed = new Set(today.map((t) => t.repository))
  const scoutedBy = group(scouted)
  return repos.map((name) => ({
    repository: name,
    busy: tasks.busy.has(name),
    baseHeld: tasks.baseHeld.has(name),
    lineStopped: stopped.has(name),
    openIssue: issues.get(name) ?? null,
    proposedToday: proposed.has(name),
    scouted: Object.fromEntries(
      (scoutedBy.get(name) ?? [])
        .filter((s): s is typeof s & { kind: ImproverKind } =>
          (IMPROVER_KINDS as readonly string[]).includes(s.kind),
        )
        .map((s) => [s.kind, s.at]),
    ),
  }))
}

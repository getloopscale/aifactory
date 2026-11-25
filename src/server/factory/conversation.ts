import type { SandboxBackend } from '@theokit/agents/sandbox'
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm'

import type { Database } from '../db'
import { agentMessage, agentRun, task } from '../db/schema'
import { KnowledgeFeed } from '../knowledge/feed'
import { knowledgeRules } from '../knowledge/prompt'
import { fetchIssue as defaultFetchIssue } from '../github/issues'
import { createGithubApi } from '../github/pulls'
import { integrationBranch } from './branches'
import { cloneRepository } from './clone'
import { githubEgress } from './credential-renewal'
import { errorMessage } from './error-message'
import type { CodingHarness, HarnessResult } from './harness'
import { INSTANCE, mergeEgress } from './run-support'
import { DEFAULT_TIMEOUTS } from './run'
import { labelsWithRepoChoice, loadRepoConfig } from './repo-config'
import { MAX_RUN_MS, resolveTimeouts } from './run-limit'
import type { RunTaskDeps } from './run-types'
import { pauseOnRefusal } from './provider-pause-store'
import { createIsolatedSandbox, type SandboxSpec } from './sandbox'
import { untilSlotFree } from './sandbox-slot'
import { restoreSession, saveSession, storedSession } from './agent-session'
import { outcome } from './transitions'
import { SANDBOX_PROVIDER_BLOCKED } from '../../shared/panel'

/** What a failed ask says when the agent touched the repository. */
export const CHANGED_IN_ASK = 'the agent changed the repository in ask mode'

/** A claim older than this is the claim of a worker that died: the message is taken again. */
export const CLAIM_STALE_MS = MAX_RUN_MS + 10 * 60_000

type Message = typeof agentMessage.$inferSelect

/**
 * Takes the oldest pending message of the task, and only when nobody holds it. Messages of one task are
 * delivered one at a time, oldest first: a worker that finds the oldest claimed gets nothing, and the one that
 * holds it goes on to the next when it is done.
 */
export async function claimNext(
  db: Database,
  taskId: number,
  now = new Date(),
): Promise<Message | undefined> {
  const oldest = sql`(select id from agent_message where task_id = ${taskId} and delivery = 'pending' order by id limit 1)`
  const [claimed] = await db
    .update(agentMessage)
    .set({ claimedAt: now })
    .where(
      and(
        eq(agentMessage.id, oldest as never),
        or(
          isNull(agentMessage.claimedAt),
          lt(agentMessage.claimedAt, new Date(now.getTime() - CLAIM_STALE_MS)),
        ),
      ),
    )
    .returning()
  return claimed
}

type Ended = {
  delivery: 'delivered' | 'failed'
  reason?: string
  answer?: string
  costUsd?: number
}

async function finish(db: Database, id: number, ended: Ended): Promise<void> {
  await db
    .update(agentMessage)
    .set({
      delivery: ended.delivery,
      reason: ended.reason ?? null,
      answer: ended.answer ?? null,
      answeredAt: new Date(),
      costUsd: ended.costUsd ?? null,
    })
    .where(eq(agentMessage.id, id))
}

/** The repository's state a read-only turn must leave as it found it. */
async function repositoryState(backend: SandboxBackend, repoDir: string): Promise<string> {
  const status = await backend.execute(`git -C ${repoDir} status --porcelain`)
  const head = await backend.execute(`git -C ${repoDir} rev-parse HEAD`)
  if (status.exitCode !== 0 || head.exitCode !== 0) {
    throw new Error(`cannot read the repository state: ${(status.stderr || head.stderr).trim()}`)
  }
  return `${head.stdout.trim()}\n${status.stdout}`
}

export type AskTurn = { changed: boolean; result: HarnessResult }

/**
 * One read-only turn: resumes the session with the prompt in ask mode, then reads `git status --porcelain` and
 * HEAD. A change to either is the answer's end: nothing is pushed here, ever, and the caller fails the message.
 */
export async function askTurn(
  backend: SandboxBackend,
  harness: CodingHarness,
  turn: { repoDir: string; sessionId: string; prompt: string; timeoutMs: number },
): Promise<AskTurn> {
  if (!harness.resume) throw new Error(`${harness.name} cannot resume a session`)
  const before = await repositoryState(backend, turn.repoDir)
  const result = await harness.resume(backend, turn.sessionId, {
    prompt: turn.prompt,
    cwd: turn.repoDir,
    timeoutMs: turn.timeoutMs,
    ask: true,
  })
  const after = await repositoryState(backend, turn.repoDir)
  return { changed: before !== after, result }
}

/** What the agent is told with the owner's words. */
export function askPrompt(text: string, knowledgeDir?: string): string {
  return `The owner of the factory writes to you about the work of this task, in a session you already have.
Answer from what you know of it and from reading the repository. Do not change any file and do not run a
command that writes: this is a question, and anything you change is thrown away.
${knowledgeDir ? `\n${knowledgeRules(knowledgeDir)}\n` : ''}
The owner writes:

${text}
`
}

/** The `agent_run` row of a conversation pass. */
export function conversationRun(
  taskId: number,
  harness: CodingHarness,
  result: HarnessResult,
  durationMs: number,
  ok: boolean,
): typeof agentRun.$inferInsert {
  return {
    taskId,
    role: 'builder',
    harness: harness.name,
    model: result.model === undefined ? (harness.model ?? null) : result.model,
    effort: harness.effort ?? null,
    tokensIn: result.tokensIn ?? null,
    tokensOut: result.tokensOut ?? null,
    attempt: 0,
    costUsd: result.costUsd ?? null,
    durationMs,
    ok,
    quota: result.quota !== undefined,
    sessionId: result.sessionId ?? null,
    conversation: true,
  }
}

/** Books the pass on the task and on `agent_run`, marked as conversation. */
export async function bookCost(
  db: Database,
  taskId: number,
  harness: CodingHarness,
  result: HarnessResult,
  durationMs: number,
  ok: boolean,
): Promise<void> {
  const cost = result.costUsd ?? 0
  if (cost > 0) {
    await db
      .update(task)
      .set({ costUsd: sql`${task.costUsd} + ${cost}` })
      .where(eq(task.id, taskId))
  }
  await db.insert(agentRun).values(conversationRun(taskId, harness, result, durationMs, ok))
}

/** Saves the session only while the task's agent is still stopped; answers why not when it is not. */
export async function keepSessionIfStopped(
  db: Database,
  backend: SandboxBackend,
  harness: CodingHarness,
  taskId: number,
  sessionId: string,
): Promise<string | undefined> {
  return db.transaction(async (tx) => {
    const [now] = await tx.select().from(task).where(eq(task.id, taskId)).for('update')
    const allowed = now ? outcome({ ...now, conversation: 'ask' }, 'conversation') : undefined
    if (allowed?.kind !== 'action') {
      const why = allowed ? allowed.reason : 'the task is gone'
      return `the task moved on while the agent answered, so its session was not touched: ${why}`
    }
    await saveSession(tx as never, backend, harness, { taskId, role: 'builder', sessionId })
    return undefined
  })
}

/**
 * Delivers one claimed ask message: a sandbox cloned from the task's branch, the stored session restored and
 * resumed with the message as its prompt, read-only. The answer, or why there is none, is stored on the message.
 * It never throws for a failed delivery: the message says what happened.
 */
export async function deliverMessage(
  deps: RunTaskDeps,
  message: Message,
  signal?: AbortSignal,
): Promise<Ended> {
  const ended = await attempt(deps, message, signal).catch((error): Ended => ({
    delivery: 'failed',
    reason: signal?.aborted
      ? 'the job lease expired before the delivery finished'
      : errorMessage(error),
  }))
  await finish(deps.db, message.id, ended)
  if (ended.reason && SANDBOX_PROVIDER_BLOCKED.test(ended.reason)) {
    await pauseOnRefusal(deps.db, ended.reason).catch(() => undefined)
  }
  return ended
}

type Repo = Awaited<ReturnType<typeof loadRepoConfig>>
type Ready = { row: typeof task.$inferSelect; harness: CodingHarness; token: string; repo: Repo }

/** The task, its stored session and the harness of that session, or why the message cannot be delivered. */
export async function readyToDeliver(deps: RunTaskDeps, message: Message): Promise<Ready | Ended> {
  const { db } = deps
  const [row] = await db.select().from(task).where(eq(task.id, message.taskId))
  if (!row) return { delivery: 'failed', reason: `task ${message.taskId} does not exist` }
  // The task may have gone back to work since the message was written: one writer per session.
  const allowed = outcome({ ...row, conversation: 'ask' }, 'conversation')
  if (allowed.kind !== 'action') return { delivery: 'failed', reason: allowed.reason }
  const stored = await storedSession(db, { taskId: row.id, role: 'builder' })
  if (!stored) return { delivery: 'failed', reason: 'the task kept no session of its agent' }
  const { token } = await deps.github.installationToken(row.repository)
  const issue = await (deps.fetchIssue ?? defaultFetchIssue)(row.repository, row.issueNumber, token)
  const repo = await loadRepoConfig(db, row.repository)
  const labels = labelsWithRepoChoice(issue.labels ?? [], repo)
  const harness = typeof deps.harness === 'function' ? deps.harness(labels) : deps.harness
  if (stored.harness !== harness.name) {
    return {
      delivery: 'failed',
      reason: `the session of this task is ${stored.harness}'s, not ${harness.name}'s`,
    }
  }
  return { row, harness, token, repo }
}

/** What a finished turn comes to; the session is kept first so the next message continues from this answer. */
export async function settleTurn(
  db: Database,
  backend: SandboxBackend,
  ready: Ready,
  turn: AskTurn,
  durationMs: number,
): Promise<Ended> {
  const { row, harness } = ready
  const { result } = turn
  const costUsd = result.costUsd
  if (turn.changed) {
    await bookCost(db, row.id, harness, result, durationMs, false)
    return { delivery: 'failed', reason: CHANGED_IN_ASK, costUsd }
  }
  await bookCost(db, row.id, harness, result, durationMs, result.ok)
  if (!result.ok) return { delivery: 'failed', reason: result.summary.slice(0, 500), costUsd }
  // The task's row is locked while the session is written and the stage read again: a run that began
  // meanwhile (a guide, a send-back, a retry) is the session's writer now, and an answer must not overwrite it.
  const moved = result.sessionId
    ? await keepSessionIfStopped(db, backend, harness, row.id, result.sessionId)
    : undefined
  if (moved) return { delivery: 'failed', reason: moved, answer: result.summary, costUsd }
  return { delivery: 'delivered', answer: result.summary, costUsd }
}

async function sandboxSpecFor(deps: RunTaskDeps, ready: Ready): Promise<SandboxSpec> {
  const { repo, token } = ready
  // The same limits as a run: the message widens neither the egress nor the time.
  const timeouts = resolveTimeouts(deps.timeouts ?? DEFAULT_TIMEOUTS, repo.runLimitMs)
  return {
    timeoutMs: timeouts.sandboxMs,
    cacheKey: ready.row.repository,
    ...(repo.sandboxImage ? { image: repo.sandboxImage } : {}),
    egress: [
      githubEgress(token),
      ...mergeEgress([await ready.harness.egress()]),
      { domain: 'registry.npmjs.org' },
      ...repo.egress.map((domain) => ({ domain })),
    ],
  }
}

async function attempt(
  deps: RunTaskDeps,
  message: Message,
  signal: AbortSignal | undefined,
): Promise<Ended> {
  const { db } = deps
  const ready = await readyToDeliver(deps, message)
  if (!('row' in ready)) return ready
  const { row, harness, token, repo } = ready
  const spec = await sandboxSpecFor(deps, ready)
  const branch = `factory/${row.issueNumber}`
  const api = deps.githubApi ?? createGithubApi()
  const onBranch = (await api.branchHead(row.repository, token, branch)) !== undefined
  await untilSlotFree(deps.sandbox, { ...deps.slotWait, signal })
  const started = Date.now()
  const sandbox = await createIsolatedSandbox(deps.sandbox, spec, { limitMs: Infinity, signal })
  let running = sandbox
  try {
    const { backend } = sandbox
    const { repoDir } = await cloneRepository(backend, {
      repoUrl: `https://github.com/${row.repository}.git`,
      ref: onBranch ? branch : integrationBranch(repo),
      instanceId: INSTANCE,
    })
    await harness.prepare?.(backend)
    const feed = await KnowledgeFeed.open(deps.knowledge, backend, row.repository, {
      taskId: row.id,
    })
    // Stopping the sandbox stops the feed first, so no copy goes into a sandbox that is gone.
    running = feed.attachTo(sandbox)
    const sessionId = await restoreSession(db, backend, harness, {
      taskId: row.id,
      role: 'builder',
    })
    const turn = await askTurn(backend, harness, {
      repoDir,
      sessionId,
      prompt: askPrompt(message.text, feed.dir),
      timeoutMs: resolveTimeouts(deps.timeouts ?? DEFAULT_TIMEOUTS, repo.runLimitMs).agentMs,
    })
    return await settleTurn(db, backend, ready, turn, Date.now() - started)
  } finally {
    await running.stop().catch(() => undefined)
  }
}

/** Delivers the task's pending messages, oldest first, until none is left that this worker may take. */
export async function deliverPending(
  deps: RunTaskDeps,
  taskId: number,
  signal?: AbortSignal,
): Promise<Ended[]> {
  const done: Ended[] = []
  for (;;) {
    if (signal?.aborted) return done
    const claimed = await claimNext(deps.db, taskId)
    if (!claimed) return done
    done.push(await deliverMessage(deps, claimed, signal))
  }
}

/** The messages of a task, oldest first. */
export const messagesOf = (db: Database, taskId: number) =>
  db
    .select()
    .from(agentMessage)
    .where(eq(agentMessage.taskId, taskId))
    .orderBy(asc(agentMessage.id))

/** A message nobody took for this long has lost its job, so another is queued for it. */
export const UNTAKEN_MS = 5 * 60_000

/**
 * The tasks whose oldest pending message waits with no worker: never claimed for `UNTAKEN_MS` (its job was lost),
 * or claimed so long ago that the worker is gone (`CLAIM_STALE_MS`). The job has one attempt, so nothing else
 * would deliver them until a later message queued a new job.
 */
export async function stuckConversations(
  db: Database,
  now = new Date(),
): Promise<{ taskId: number; messageId: number; claimedAt: Date | null }[]> {
  const untaken = new Date(now.getTime() - UNTAKEN_MS)
  const stale = new Date(now.getTime() - CLAIM_STALE_MS)
  const oldest = await db
    .selectDistinctOn([agentMessage.taskId], {
      taskId: agentMessage.taskId,
      messageId: agentMessage.id,
      claimedAt: agentMessage.claimedAt,
      createdAt: agentMessage.createdAt,
    })
    .from(agentMessage)
    .where(eq(agentMessage.delivery, 'pending'))
    .orderBy(agentMessage.taskId, agentMessage.id)
  return oldest
    .filter((m) => (m.claimedAt ? m.claimedAt < stale : m.createdAt < untaken))
    .map(({ taskId, messageId, claimedAt }) => ({ taskId, messageId, claimedAt }))
}

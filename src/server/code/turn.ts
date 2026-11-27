import { SANDBOX_PROVIDER_BLOCKED } from '../../shared/panel'
import type { CodeEvent, CodeEventKind, CodeSession } from '../../shared/code'
import type { CodeTransitionEvent } from './transitions'
import type { CodingHarness, HarnessInput, HarnessResult } from '../factory/harness'
import { errorMessage } from '../factory/error-message'
import { untilSlotFree } from '../factory/sandbox-slot'
import type { agentRun } from '../db/schema'

import { planPrompt } from '../agents/prompts/code-plan'
import { turnMarker, type Claim, type NewCodeEvent } from './store'
import { codeCapReached } from './slots'
import { revertChanges } from './readonly-workspace'
import {
  closeWorkspace,
  openWorkspace,
  retainWorkspace,
  WorkspaceCapped,
  type WorkspaceDeps,
} from './workspace'

/** What a turn reads and writes in the database, so a test can stand in for it. */
export type TurnStore = {
  claim(sessionId: string): Promise<Claim>
  append(sessionId: string, event: NewCodeEvent): Promise<CodeEvent>
  move(sessionId: string, event: CodeTransitionEvent): Promise<unknown>
  saveAgentSession(sessionId: string, agentSessionId: string, harness: string): Promise<void>
}

export type TurnDeps = {
  store: TurnStore
  /** The workspace's own dependencies, minus the harness, which is the session's. */
  workspace: Omit<WorkspaceDeps, 'harness'>
  /** The agent the session chose; throws when it is unknown or has no credential. */
  harnessFor(session: CodeSession): CodingHarness
  record(values: typeof agentRun.$inferInsert): Promise<unknown>
  /** Remembers a refusal of the sandbox provider for credit or spending, so no run starts a sandbox for a while. */
  onRefusal(error: string): Promise<void>
  agentTimeoutMs?: number
  /** How many code workspaces may be up; a turn that would start one over it waits in the queue. Absent is no cap. */
  codeCap?: number
  /** Runs `work` alone among the turns of every process, so the cap is counted and claimed in one step. */
  underCapLock?<T>(work: () => Promise<T>): Promise<T>
  /** Leaves the sandbox up after a turn that worked, for the idle cron to close. */
  keepWorkspace?: boolean
  slotWait?: Parameters<typeof untilSlotFree>[1]
  signal?: AbortSignal
}

export type TurnResult =
  | { status: 'nothing' }
  /** Another turn of the session runs: the job queues itself again. */
  | { status: 'busy' }
  /** The code workspaces up fill the cap: the job queues itself again, and the session waits `queued`. */
  | { status: 'capped' }
  /** The provider refused a sandbox for credit or spending: the job queues itself again after the pause. */
  | { status: 'deferred' }
  | { status: 'idle' | 'waiting_input' | 'failed'; sessionId: string }

export const AGENT_TIMEOUT_MS = 60 * 60_000

const KINDS: Partial<Record<string, CodeEventKind>> = {
  message: 'agent_message',
  tool_use: 'tool_use',
  tool_result: 'tool_result',
  error: 'error',
}

/** Appends what the harness reports one after the other, whatever the speed it reports at. */
function serialWriter(store: TurnStore, sessionId: string, holdMessages = false) {
  let lastMessage = ''
  let chain: Promise<unknown> = Promise.resolve()
  let failure: unknown
  return {
    onEvent(event: { kind: string; content: string; tool?: string }) {
      const kind = KINDS[event.kind]
      // The harness's own cost event is ignored: the turn writes one from the final result.
      if (!kind) return
      // A plan turn's answer is the plan: it is kept as one `plan` event, so the messages are not shown twice.
      if (holdMessages && kind === 'agent_message') {
        lastMessage = event.content
        return
      }
      chain = chain
        .then(
          () =>
            failure ?? store.append(sessionId, { kind, content: event.content, tool: event.tool }),
        )
        .catch((error: unknown) => {
          failure = error
        })
    },
    lastMessage: () => lastMessage,
    async drain() {
      await chain
      if (failure) throw failure
    },
  }
}

function failureText(result: HarnessResult): string {
  if (result.quota) {
    const resets = result.quota.resetsAt ? ` (resets ${result.quota.resetsAt})` : ''
    return `The agent stopped because its quota ran out${resets}: ${result.quota.message}`
  }
  return result.summary || 'The agent failed.'
}

/**
 * One turn of a code session: takes the oldest unanswered message, runs the session's harness on it in the
 * workspace and writes each step to the session's events. The session ends `idle`, or `failed` with an `error`.
 */
export async function runTurn(deps: TurnDeps, sessionId: string): Promise<TurnResult> {
  const { store } = deps
  const claim = await store.claim(sessionId)
  if (claim.kind !== 'claimed') return { status: claim.kind }
  const { session, message } = claim

  let harness: CodingHarness
  let workspace: Awaited<ReturnType<typeof openWorkspace>>
  try {
    harness = deps.harnessFor(session)
    await untilSlotFree(deps.workspace.sandbox, { ...deps.slotWait, signal: deps.signal })
    // The count and the sandbox it counts are one step: the lock is held until the workspace is up.
    const lock = deps.underCapLock ?? ((work) => work())
    const opened = await lock(async () => {
      // The cap is asked only when a new sandbox is needed: a session whose retained sandbox is still up needs none.
      const mayStart =
        deps.codeCap === undefined
          ? undefined
          : async () => !(await codeCapReached(deps.workspace.sandbox, deps.codeCap!))
      try {
        return await openWorkspace({ ...deps.workspace, harness, mayStart }, session)
      } catch (error) {
        if (error instanceof WorkspaceCapped) return undefined
        throw error
      }
    })
    if (!opened) {
      await store.move(sessionId, 'turn_released')
      return { status: 'capped' }
    }
    workspace = opened
  } catch (error) {
    const reason = errorMessage(error)
    if (SANDBOX_PROVIDER_BLOCKED.test(reason)) {
      await deps.onRefusal(reason)
      await store.move(sessionId, 'turn_released')
      return { status: 'deferred' }
    }
    return fail(deps, sessionId, message, reason)
  }

  const started = Date.now()
  let result: HarnessResult | undefined
  let failure: string | undefined
  let marked = false
  let plan = ''
  try {
    await store.move(sessionId, 'turn_started')
    await store.append(sessionId, {
      kind: 'state',
      content: turnMarker(message.seq),
      tool: session.mode,
    })
    marked = true
    const planning = session.mode === 'plan'
    const writer = serialWriter(store, sessionId, planning)
    const input: HarnessInput = {
      prompt: planning ? planPrompt(message.content) : message.content,
      cwd: workspace.repoDir,
      timeoutMs: deps.agentTimeoutMs ?? AGENT_TIMEOUT_MS,
      onEvent: writer.onEvent,
      ...(session.mode === 'code' ? {} : { ask: true }),
    }
    const resumable =
      session.agentSessionId &&
      harness.resume &&
      (session.agentSessionHarness ?? harness.name) === harness.name
    try {
      result = resumable
        ? await harness.resume!(workspace.backend, session.agentSessionId!, input)
        : await harness.run(workspace.backend, input)
    } finally {
      await writer.drain()
    }
    if (!result.ok) failure = failureText(result)
    else if (planning) {
      plan = (result.summary || writer.lastMessage()).trim()
      if (!plan) failure = 'The agent answered with no plan.'
    }
  } catch (error) {
    failure = errorMessage(error)
  }

  // Ask and Plan may not change the checkout: whatever the agent left is put back before the workspace is saved.
  if (session.mode !== 'code') {
    try {
      const reverted = await revertChanges(workspace.backend, workspace.repoDir)
      if (reverted.length > 0) {
        await store.append(sessionId, {
          kind: 'error',
          content: `The agent tried to change the checkout in ${session.mode} mode. Reverted: ${reverted.join(', ')}`,
        })
      }
    } catch (error) {
      workspace.feed.stop()
      await workspace.sandbox.stop().catch(() => undefined)
      return fail(
        deps,
        sessionId,
        message,
        `The checkout could not be reverted in ${session.mode} mode, so the workspace was not saved: ${errorMessage(error)}`,
        marked,
      )
    }
  }

  try {
    const keep =
      deps.keepWorkspace &&
      failure === undefined &&
      result?.ok &&
      workspace.sandbox.id &&
      deps.workspace.sandbox.reconnect
    if (keep) await retainWorkspace(deps.workspace, session, workspace)
    else await closeWorkspace(deps.workspace, session, workspace)
  } catch (error) {
    console.warn(`code_workspace_not_saved session=${sessionId}: ${errorMessage(error)}`)
  }

  try {
    if (result) {
      await recordResult(deps, session, message, harness, result, Date.now() - started)
    }
    if (failure === undefined && result) {
      await store.append(sessionId, {
        kind: 'cost',
        content: JSON.stringify({ costUsd: result.costUsd ?? null }),
      })
      if (plan) {
        await store.append(sessionId, { kind: 'plan', content: plan })
        await store.move(sessionId, 'plan_proposed')
        return { status: 'waiting_input', sessionId }
      }
      await store.move(sessionId, 'turn_ended')
      return { status: 'idle', sessionId }
    }
  } catch (error) {
    // A step after the pass failed: the session must not stay claimed, or its later turns wait for ever.
    failure = errorMessage(error)
  }
  return fail(deps, sessionId, message, failure ?? 'The turn failed.', marked)
}

async function recordResult(
  deps: TurnDeps,
  session: CodeSession,
  message: CodeEvent,
  harness: CodingHarness,
  result: HarnessResult,
  durationMs: number,
): Promise<void> {
  if (result.sessionId) {
    await deps.store.saveAgentSession(session.id, result.sessionId, harness.name)
  }
  await deps.record({
    taskId: null,
    role: 'code',
    codeSessionId: session.id,
    codeMessageSeq: message.seq,
    harness: harness.name,
    model: result.model === undefined ? (harness.model ?? null) : result.model,
    effort: harness.effort ?? null,
    tokensIn: result.tokensIn ?? null,
    tokensOut: result.tokensOut ?? null,
    attempt: 1,
    costUsd: result.costUsd ?? null,
    durationMs,
    ok: result.ok,
    quota: result.quota !== undefined,
    sessionId: result.sessionId ?? null,
  })
}

/**
 * Ends the turn as failed. The message counts as answered (the marker names it, written first when the turn did
 * not get to write it), so the next message is not held behind it. When writing the error itself fails the
 * session is still moved, and the write's error is thrown after.
 */
async function fail(
  deps: TurnDeps,
  sessionId: string,
  message: CodeEvent,
  reason: string,
  marked = false,
): Promise<TurnResult> {
  const { store } = deps
  try {
    if (!marked) await store.append(sessionId, { kind: 'state', content: turnMarker(message.seq) })
    await store.append(sessionId, { kind: 'error', content: reason })
  } finally {
    await store.move(sessionId, 'turn_failed')
  }
  return { status: 'failed', sessionId }
}

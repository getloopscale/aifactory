import { createHash } from 'node:crypto'

/**
 * Turns one finished agent pass into an OTLP JSON payload (`POST /v1/traces`). It reads nothing: the pass, its
 * task and its stored steps (already redacted and cut by `factory/transcript.ts`) come in, the payload goes out.
 * Ids come from the pass id and each step's `seq`, so exporting a pass twice sends the same ids.
 */

export type PassRun = {
  id: number
  role: string
  harness: string
  model: string | null
  effort: string | null
  tokensIn: number | null
  tokensOut: number | null
  attempt: number
  costUsd: number | null
  durationMs: number
  ok: boolean
  at: Date
}

export type PassTask = { id: number; repository: string; issueNumber: number }

export type PassEvent = {
  seq: number
  kind: 'message' | 'tool_use' | 'tool_result' | 'cost' | 'error'
  tool: string | null
  content: string
  at: Date
}

type Value = string | number | boolean
type Attributes = Record<string, Value | null | undefined>

/** The attribute Looptrace groups traces into sessions by (assumed: its source was not reachable). */
export const SESSION_ATTRIBUTE = 'session.id'

export const sessionOf = (taskId: number) => `task:${taskId}`

const hex = (seed: string, bytes: number) =>
  createHash('sha256')
    .update(seed)
    .digest('hex')
    .slice(0, bytes * 2)

export const traceIdOf = (runId: number) => hex(`aifactory:trace:${runId}`, 16)
export const spanIdOf = (runId: number, seq: number | 'root') =>
  hex(`aifactory:span:${runId}:${seq}`, 8)

const nano = (at: number) => String(BigInt(Math.trunc(at)) * 1_000_000n)

function attributes(values: Attributes) {
  return Object.entries(values).flatMap(([key, value]) => {
    if (value === null || value === undefined) return []
    const wrapped =
      typeof value === 'string'
        ? { stringValue: value }
        : typeof value === 'boolean'
          ? { boolValue: value }
          : Number.isInteger(value)
            ? { intValue: String(value) }
            : { doubleValue: value }
    return [{ key, value: wrapped }]
  })
}

type Span = {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: 1
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: ReturnType<typeof attributes>
  status: { code: 1 | 2; message?: string }
}

type Step = { first: PassEvent; second?: PassEvent }

/** A `tool_use` and the next unanswered `tool_result` of the same tool are one step; the other kinds stand alone. */
function steps(events: PassEvent[]): Step[] {
  const out: Step[] = []
  const open: Step[] = []
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.kind === 'cost') continue
    if (event.kind === 'tool_use') {
      const step = { first: event }
      open.push(step)
      out.push(step)
      continue
    }
    if (event.kind === 'tool_result') {
      const at = open.findIndex((s) => s.first.tool === event.tool)
      const step = at >= 0 ? open.splice(at, 1)[0] : undefined
      if (step) step.second = event
      else out.push({ first: event })
      continue
    }
    out.push({ first: event })
  }
  return out
}

export function passToOtlp(run: PassRun, task: PassTask, events: PassEvent[]) {
  const traceId = traceIdOf(run.id)
  const root = spanIdOf(run.id, 'root')
  const end = run.at.getTime()
  const start = end - run.durationMs
  const session = sessionOf(task.id)

  const rootSpan: Span = {
    traceId,
    spanId: root,
    name: `${run.role} pass`,
    kind: 1,
    startTimeUnixNano: nano(start),
    endTimeUnixNano: nano(end),
    attributes: attributes({
      [SESSION_ATTRIBUTE]: session,
      'gen_ai.conversation.id': session,
      'gen_ai.system': run.harness,
      'gen_ai.request.model': run.model,
      'gen_ai.usage.input_tokens': run.tokensIn,
      'gen_ai.usage.output_tokens': run.tokensOut,
      'factory.role': run.role,
      'factory.attempt': run.attempt,
      'factory.harness': run.harness,
      'factory.effort': run.effort,
      'factory.cost_usd': run.costUsd,
      'factory.duration_ms': run.durationMs,
      'factory.ok': run.ok,
      'factory.repository': task.repository,
      'factory.task_id': task.id,
      'factory.issue_number': task.issueNumber,
    }),
    status: run.ok ? { code: 1 } : { code: 2 },
  }

  const list = steps(events)
  const children: Span[] = list.map(({ first, second }, i) => {
    const from = first.at.getTime()
    const next = list[i + 1]?.first.at.getTime() ?? end
    const to = Math.max(from, second ? second.at.getTime() : Math.min(next, Math.max(from, end)))
    const isError = first.kind === 'error'
    const name = first.kind === 'message' || isError ? first.kind : (first.tool ?? first.kind)
    return {
      traceId,
      spanId: spanIdOf(run.id, first.seq),
      parentSpanId: root,
      name,
      kind: 1,
      startTimeUnixNano: nano(from),
      endTimeUnixNano: nano(to),
      attributes: attributes({
        [SESSION_ATTRIBUTE]: session,
        'factory.event.kind': first.kind,
        'factory.event.seq': first.seq,
        'gen_ai.tool.name': first.kind === 'message' || isError ? null : first.tool,
        'factory.input': first.kind === 'tool_use' ? first.content : null,
        'factory.output': second
          ? second.content
          : first.kind === 'tool_use'
            ? null
            : first.content,
      }),
      status: isError ? { code: 2, message: first.content.slice(0, 200) } : { code: 1 },
    }
  })

  return {
    resourceSpans: [
      {
        resource: { attributes: attributes({ 'service.name': 'aifactory' }) },
        scopeSpans: [{ scope: { name: 'aifactory.trace' }, spans: [rootSpan, ...children] }],
      },
    ],
  }
}

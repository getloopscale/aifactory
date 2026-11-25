import type { MessageView, TranscriptEvent } from '../../shared/panel'

import { transcriptRows, type TranscriptRow } from './transcript'

export type ThreadRole = TranscriptEvent['role']
export type ToolKind = 'read' | 'search' | 'edit' | 'command' | 'other'
export type ToolCounts = Partial<Record<ToolKind, number>>
type ToolStep = Extract<TranscriptRow, { type: 'tool' }>

/** One row of an agent's conversation, oldest first. */
export type ThreadRow =
  | {
      type: 'owner'
      key: string
      role: ThreadRole
      at: string
      text: string
      mode: 'ask' | 'guide'
      delivery: 'pending' | 'delivered' | 'failed'
      reason: string | null
    }
  | { type: 'said'; key: string; role: ThreadRole; at: string; text: string }
  | {
      type: 'work'
      key: string
      role: ThreadRole
      at: string
      steps: TranscriptRow[]
      counts: ToolCounts
      failed: number
    }
  | {
      type: 'pass'
      key: string
      role: ThreadRole
      at: string
      engine: string | null
      elapsedMs: number
      /** The tool the agent is in the middle of, if any. */
      doing: { tool: string; target: string } | null
    }
  | {
      type: 'worked'
      key: string
      role: ThreadRole
      at: string
      engine: string | null
      durationMs: number
      steps: TranscriptRow[]
      counts: ToolCounts
      failed: number
    }

export type ThreadOptions = {
  /** The role whose pass is running now. */
  running?: ThreadRole
  /** The engine a role runs on. */
  engineOf?: (role: ThreadRole) => string | null
}

export function toolKind(tool: string): ToolKind {
  if (/grep|glob|search|find|^ls$|list/i.test(tool)) return 'search'
  if (/read|view|open|cat/i.test(tool)) return 'read'
  if (/edit|write|patch|apply|create/i.test(tool)) return 'edit'
  if (/bash|shell|exec|command|run/i.test(tool)) return 'command'
  return 'other'
}

function count(steps: TranscriptRow[]): { counts: ToolCounts; failed: number } {
  const counts: ToolCounts = {}
  let failed = 0
  for (const s of steps) {
    if (s.type !== 'tool') continue
    const kind = toolKind(s.tool)
    counts[kind] = (counts[kind] ?? 0) + 1
    if (s.status === 'failed') failed++
  }
  return { counts, failed }
}

/** `4m 12s`, `12s`, `1h 2m`. */
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

type Pass = { role: ThreadRole; attempt: number; events: TranscriptEvent[] }
type Entry = { at: number; step: TranscriptRow } | { at: number; message: MessageView }

/** A pass is a run of steps of one role and attempt: the events carry no pass id. */
function passesOf(events: TranscriptEvent[]): Pass[] {
  const passes: Pass[] = []
  for (const e of events) {
    const last = passes.at(-1)
    if (last && last.role === e.role && last.attempt === e.attempt) last.events.push(e)
    else passes.push({ role: e.role, attempt: e.attempt, events: [e] })
  }
  return passes
}

const foldable = (s: TranscriptRow) =>
  s.type === 'tool' ? s.status !== 'failed' : s.type === 'note' ? !s.failed : false

function ownerRows(m: MessageView, role: ThreadRole): ThreadRow[] {
  const rows: ThreadRow[] = [
    {
      type: 'owner',
      key: `m-${m.id}`,
      role,
      at: m.at,
      text: m.text,
      mode: m.mode,
      delivery: m.delivery,
      reason: m.reason,
    },
  ]
  if (m.answer)
    rows.push({ type: 'said', key: `a-${m.id}`, role, at: m.answeredAt ?? m.at, text: m.answer })
  return rows
}

function passRows(
  pass: Pass,
  messages: MessageView[],
  running: boolean,
  now: number,
  engine: string | null,
): ThreadRow[] {
  const atOf = new Map(pass.events.map((e) => [e.seq, Date.parse(e.at)]))
  const firstSeq = pass.events[0]?.seq ?? 0
  const startAt = pass.events[0]?.at ?? ''
  const lastAt = Date.parse(pass.events.at(-1)?.at ?? startAt)
  const steps = transcriptRows(pass.events, running)
  const entries: Entry[] = steps.map((step) => ({ at: atOf.get(step.seq) ?? 0, step }))
  for (const message of [...messages].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const at = Date.parse(message.at)
    const index = entries.findIndex((e) => e.at > at)
    entries.splice(index === -1 ? entries.length : index, 0, { at, message })
  }
  const lastSay = [...steps].reverse().find((s) => s.type === 'say')

  if (!running) {
    const folded = steps.filter((s) => foldable(s) || (s.type === 'say' && s !== lastSay))
    const rows: ThreadRow[] = []
    if (folded.length > 0)
      rows.push({
        type: 'worked',
        key: `d-${firstSeq}`,
        role: pass.role,
        at: startAt,
        engine,
        durationMs: lastAt - Date.parse(startAt),
        steps: folded,
        ...count(folded),
      })
    for (const e of entries) {
      if ('message' in e) rows.push(...ownerRows(e.message, pass.role))
      else if (!folded.includes(e.step)) rows.push(...single(e.step, pass.role, atOf))
    }
    return rows
  }

  const open = [...steps]
    .reverse()
    .find((s): s is ToolStep => s.type === 'tool' && s.status === 'running')
  const rows: ThreadRow[] = [
    {
      type: 'pass',
      key: `p-${firstSeq}`,
      role: pass.role,
      at: startAt,
      engine,
      elapsedMs: now - Date.parse(startAt),
      doing: open ? { tool: open.tool, target: open.target } : null,
    },
  ]
  let group: TranscriptRow[] = []
  const flush = () => {
    if (group.some((s) => s.type === 'tool'))
      rows.push({
        type: 'work',
        key: `w-${group[0]?.seq}`,
        role: pass.role,
        at: atIso(group[0], atOf),
        steps: group,
        ...count(group),
      })
    group = []
  }
  for (const e of entries) {
    if ('message' in e) {
      flush()
      rows.push(...ownerRows(e.message, pass.role))
    } else if (foldable(e.step)) group.push(e.step)
    else {
      flush()
      rows.push(...single(e.step, pass.role, atOf))
    }
  }
  flush()
  return rows
}

function atIso(step: TranscriptRow | undefined, atOf: Map<number, number>): string {
  return new Date(atOf.get(step?.seq ?? -1) ?? 0).toISOString()
}

/** A step that stays on its own: text, or a failed step. A failed one is shown as a `work` of one step. */
function single(step: TranscriptRow, role: ThreadRole, atOf: Map<number, number>): ThreadRow[] {
  if (step.type === 'say')
    return [{ type: 'said', key: `s-${step.seq}`, role, at: step.at, text: step.text }]
  return [
    {
      type: 'work',
      key: `f-${step.seq}`,
      role,
      at: atIso(step, atOf),
      steps: [step],
      ...count([step]),
    },
  ]
}

/**
 * The rows of the conversation with an agent: what the owner wrote and what the agent said and did, in the
 * order it happened. Tool steps fold into one row, and a finished pass into `worked`; a failed step, a message
 * of the owner, the pass that runs and the last text of each pass never fold. A message belongs to the pass
 * it was written during, since it names no agent.
 */
export function threadRows(
  events: TranscriptEvent[],
  messages: MessageView[],
  now: number,
  options: ThreadOptions = {},
): ThreadRow[] {
  const passes = passesOf([...events].sort((a, b) => a.seq - b.seq))
  const starts = passes.map((p) => Date.parse(p.events[0]?.at ?? ''))
  const owned: MessageView[][] = passes.map(() => [])
  const loose: MessageView[] = []
  for (const m of messages) {
    const at = Date.parse(m.at)
    const index = starts.reduce((found, s, i) => (s <= at ? i : found), -1)
    if (index === -1) loose.push(m)
    else owned[index]?.push(m)
  }
  const first = passes[0]?.role ?? options.running ?? 'builder'
  const rows: ThreadRow[] = loose
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .flatMap((m) => ownerRows(m, first))
  passes.forEach((pass, i) => {
    const running = i === passes.length - 1 && options.running === pass.role
    rows.push(
      ...passRows(pass, owned[i] ?? [], running, now, options.engineOf?.(pass.role) ?? null),
    )
  })
  return rows
}

/** The roles that have rows, the running one first. */
export function threadRoles(rows: ThreadRow[], running?: ThreadRole): ThreadRole[] {
  const roles = [...new Set(rows.map((r) => r.role))]
  return roles.sort((a, b) => Number(b === running) - Number(a === running))
}

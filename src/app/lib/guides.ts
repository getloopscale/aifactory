import type { GuideId } from '../../shared/guides'
import type { RepositoryView } from '../../shared/panel'

import { en, type Copy } from './copy/en'

export type Starter = {
  text: string
  /** Put it in the box for the owner to finish, instead of sending it. */ fill?: boolean
}

export type Guide = {
  id: GuideId
  /** What the specialist is called, in the owner's language. */
  name: string
  /** What the menu calls the place, in the language the guide's agent is told (it is context for the agent). */
  place: string
  /** One sentence on what the page is for, shown before the owner has asked anything. */
  about: string
  understand: Starter[]
  act: Starter[]
  /** A line under the box, for what the owner should know before typing. */
  note?: string
}

/** The place as the agent of the guide is told it: part of the context it gets, not of what the owner reads. */
const AGENT_PLACE: Record<GuideId, string> = {
  board: 'Quadro',
  plans: 'Planos',
  repositories: 'Repositórios',
  inbox: 'Caixa de entrada',
  health: 'Saúde',
  agents: 'Agentes',
  setup: 'Configuração',
}

/** The guide of a place, with what the owner reads of it taken from the dictionary of their language. */
export function guideIn(id: GuideId, t: Copy): Guide {
  const content = t.guides[id] as {
    about: string
    understand: string[]
    act: Starter[]
    note?: string
  }
  return {
    id,
    name: t.guides.names[id],
    place: AGENT_PLACE[id],
    about: content.about,
    understand: content.understand.map((text) => ({ text })),
    act: content.act,
    ...(content.note ? { note: content.note } : {}),
  }
}

const PLACES: [RegExp, GuideId][] = [
  [/^\/(work|tasks)(\/|$)/, 'board'],
  [/^\/plans(\/|$)/, 'plans'],
  [/^\/repositories(\/|$)/, 'repositories'],
  [/^\/inbox(\/|$)/, 'inbox'],
  [/^\/health(\/|$)/, 'health'],
  [/^\/agents(\/|$)/, 'agents'],
  [/^\/setup(\/|$)/, 'setup'],
]

/** Which guide the page the owner is on has, or none: the chat is the general assistant and has no guide. */
export function guideIdFor(pathname: string): GuideId | undefined {
  return PLACES.find(([pattern]) => pattern.test(pathname))?.[1]
}

/** The guide of the page the owner is on, in their language, or none. */
export function guideFor(pathname: string, t: Copy): Guide | undefined {
  const id = guideIdFor(pathname)
  return id ? guideIn(id, t) : undefined
}

/** The item the owner has open on the page, from the address: a task or a plan. */
export function focusOf(
  pathname: string,
  search: string,
): { kind: 'task' | 'plan'; id: number } | undefined {
  const params = new URLSearchParams(search)
  const fromPath = /^\/(tasks|plans)\/(\d+)$/.exec(pathname)
  if (fromPath) return { kind: fromPath[1] === 'tasks' ? 'task' : 'plan', id: Number(fromPath[2]) }
  const task = /^\d+$/.test(params.get('task') ?? '') ? Number(params.get('task')) : undefined
  return task !== undefined && pathname.startsWith('/work') ? { kind: 'task', id: task } : undefined
}

const OPEN = { task: 'a tarefa', plan: 'o plano' } as const
const OPENED = { task: 'aberta', plan: 'aberto' } as const

/** What the guide is told about where the owner is, so that "this" in their words means something. */
export function whereIs(guide: Guide, pathname: string, search: string): string {
  const focus = focusOf(pathname, search)
  const open = focus ? ` Está com ${OPEN[focus.kind]} ${focus.id} ${OPENED[focus.kind]}.` : ''
  return `Onde o dono está: página "${guide.place}" (${pathname}).${open}`
}

/** The suggestions of a guide, with the ones about the open item first. */
export function startersFor(guide: Guide, focus: ReturnType<typeof focusOf>, t: Copy) {
  const asked = !focus ? undefined : t.guides.open[focus.kind](focus.id)
  const about: Starter[] = asked ? [{ text: asked.explain }, { text: asked.act }] : []
  return {
    understand: [...about.slice(0, 1), ...guide.understand],
    act: [...about.slice(1), ...guide.act],
  }
}

/** The tools that change something: when one finishes, the page behind the guide must read again. */
export const ACTING = new Set([
  'retry_task',
  'request_changes',
  'start_job',
  'approve_task',
  'update_repository',
  'create_plan',
  'create_plan_issues',
  'resolve_finding',
  'acknowledge_watch',
  'update_agent_settings',
])

/** The tool a message part is a call of, whichever way the framework named it. */
export function toolNameOf(part: Record<string, unknown>): string | undefined {
  if (part.type === 'dynamic-tool' && typeof part.toolName === 'string') return part.toolName
  return typeof part.type === 'string' && part.type.startsWith('tool-')
    ? part.type.slice(5)
    : undefined
}

/** The ids of the calls in a conversation that changed something and finished. */
export function finishedChanges(messages: { parts: Record<string, unknown>[] }[]): string[] {
  return messages.flatMap((m) =>
    m.parts.flatMap((part) => {
      const name = toolNameOf(part)
      return name &&
        ACTING.has(name) &&
        part.state === 'output-available' &&
        typeof part.toolCallId === 'string'
        ? [part.toolCallId]
        : []
    }),
  )
}

type Fields = Copy['approvals']['fields']

const FIELDS = (
  f: Fields,
): Record<
  string,
  { label: string; of: (r: RepositoryView) => unknown; show: (v: unknown) => string }
> => {
  const yesNo = (v: unknown) => (v ? f.yes : f.no)
  const orDefault = (v: unknown) =>
    v === null || v === undefined || v === '' ? f.theDefault : String(v)
  return {
    enabled: { label: f.enabled, of: (r) => r.enabled, show: yesNo },
    checks: {
      label: f.checks,
      of: (r) => r.checks,
      show: (v) =>
        Array.isArray(v) && v.length > 0
          ? v.map((c: { name: string }) => c.name).join(', ')
          : f.defaultChecks,
    },
    egress: {
      label: f.egress,
      of: (r) => r.egress,
      show: (v) => (Array.isArray(v) && v.length > 0 ? v.join(', ') : f.none),
    },
    baseBranch: { label: f.baseBranch, of: (r) => r.baseBranch, show: orDefault },
    releaseBranch: { label: f.releaseBranch, of: (r) => r.releaseBranch, show: orDefault },
    askQuestions: { label: f.askQuestions, of: (r) => r.askQuestions, show: yesNo },
    harness: { label: f.harness, of: (r) => r.harness, show: orDefault },
    reviewer: { label: f.reviewer, of: (r) => r.reviewer, show: orDefault },
    releaseMode: {
      label: f.releaseMode,
      of: (r) => r.releaseMode,
      show: (v) => (typeof v === 'string' && v in f.release ? f.release[v] : f.factoryDefault),
    },
  }
}

/** The lines of what a save would change, "before → after" when the current settings are known. */
export function repoChanges(
  current: RepositoryView | undefined,
  input: Record<string, unknown>,
  fields: Fields = en.approvals.fields,
): string[] {
  return Object.entries(FIELDS(fields)).flatMap(([key, field]) => {
    if (!(key in input) || input[key] === undefined) return []
    const after = field.show(input[key])
    if (!current) return [`${field.label}: ${after}`]
    const before = field.show(field.of(current))
    return before === after ? [] : [`${field.label}: ${before} → ${after}`]
  })
}

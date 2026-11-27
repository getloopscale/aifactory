import type {
  AgentRole,
  ChatDetail,
  ChatMessageView,
  ChatModel,
  ChatSummary,
  RepositoryView,
} from '../../shared/panel'

import { del, get, post, put } from './api'
import { en, type Copy } from './copy/en'
import { repoChanges } from './guides'

/** The agents the owner can talk to, as the picker names them. */
export const MODELS: { id: ChatModel; name: string }[] = [
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'codex', name: 'ChatGPT' },
]

export const AGENT_PATH: Record<ChatModel, string> = {
  openrouter: '/api/agents/chat',
  codex: '/api/agents/chat-codex',
}

/**
 * The agent is asked one message at a time and keeps nothing between them, so the conversation travels
 * inside the message. This is what separates it from the new message, so the page can show only the latter.
 */
export const NEW_MESSAGE = 'Nova mensagem do dono:\n'

const HISTORY_MESSAGES = 20
const HISTORY_CHARS = 1500

/** The text of a message, whatever else its parts carry. */
export function textOf(message: Pick<ChatMessageView, 'parts'>): string {
  return message.parts
    .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('')
}

/**
 * What to send to the agent: the end of the conversation so far, then what the owner just wrote. A
 * `preface` (where the owner is, for a guide) always goes first, set apart from the new message.
 */
export function promptWith(history: ChatMessageView[], text: string, preface?: string): string {
  const lines = history
    .filter((m) => m.role !== 'system')
    .map((m) => ({ who: m.role === 'user' ? 'dono' : 'assistente', text: textOf(m).trim() }))
    .filter((m) => m.text !== '')
    .slice(-HISTORY_MESSAGES)
    .map((m) => `[${m.who}]: ${m.text.slice(0, HISTORY_CHARS)}`)
  if (lines.length === 0 && !preface) return text
  const before =
    lines.length === 0 ? '' : `Conversa até aqui, a mais antiga primeiro:\n${lines.join('\n')}\n\n`
  return `${preface ? `${preface}\n\n` : ''}${before}${NEW_MESSAGE}${text}`
}

/** A message as the owner should see it: a user message loses the history that rode along with it. */
export function displayed<M extends { role: string; parts: Record<string, unknown>[] }>(
  message: M,
): M {
  if (message.role !== 'user') return message
  return {
    ...message,
    parts: message.parts.map((part) => {
      if (part.type !== 'text' || typeof part.text !== 'string') return part
      const at = part.text.lastIndexOf(NEW_MESSAGE)
      return at === -1 ? part : { ...part, text: part.text.slice(at + NEW_MESSAGE.length) }
    }),
  }
}

/** The pinned conversations and the others, each the one touched last first. */
export function groupChats(chats: ChatSummary[], filter = '', untitled = en.menu.newChat) {
  const needle = filter.trim().toLowerCase()
  const shown = chats.filter(
    (c) => needle === '' || (c.title || untitled).toLowerCase().includes(needle),
  )
  return { pinned: shown.filter((c) => c.pinned), recent: shown.filter((c) => !c.pinned) }
}

export const chatApi = {
  create: (model: ChatModel) => post<ChatSummary>('/api/panel/chats', { model }),
  load: (id: string) => get<ChatDetail>(`/api/panel/chats/${id}`),
  save: (id: string, messages: ChatMessageView[]) =>
    put<ChatSummary>(`/api/panel/chats/${id}/messages`, { messages }),
  patch: (id: string, patch: { title?: string; pinned?: boolean; model?: ChatModel }) =>
    put<ChatSummary>(`/api/panel/chats/${id}`, patch),
  remove: (id: string) => del<{ removed: boolean }>(`/api/panel/chats/${id}`),
}

/**
 * The conversation the page just kept, for the page that opens at its address. A new conversation gets its
 * address once its first answer is finished, and the page there is another one: without this it would start by
 * loading, and the answer the owner was reading would vanish and come back.
 */
let handed: { id: string; messages: ChatMessageView[]; model: ChatModel } | undefined

export const handOver = (id: string, messages: ChatMessageView[], model: ChatModel) => {
  handed = { id, messages, model }
}

/** What was handed over for this conversation, if it is the one just kept. */
export const handedOver = (id: string | undefined) =>
  handed && handed.id === id ? handed : undefined

export type Connection = {
  connected: boolean
  login:
    | { status: 'idle' }
    | { status: 'waiting'; userCode: string; verificationUri: string }
    | { status: 'error'; message: string }
}

type Approval = { title: string; request: string }
type Args = Record<string, unknown>
type Approvals = Copy['approvals']

const text = (v: unknown) => String(v ?? '')

/** What each tool that changes something says to the owner before it runs. */
const APPROVALS: Record<string, (a: Args, t: Approvals, repo?: RepositoryView) => Approval> = {
  retry_task: (a, t) => ({
    title: t.retryTask.title,
    request: t.retryTask.request(String(a.id)),
  }),
  request_changes: (a, t) => ({
    title: t.requestChanges.title,
    request: t.requestChanges.request(String(a.id), text(a.note)),
  }),
  start_job: (a, t) => ({
    title: t.startJob.title,
    request: t.startJob.request(String(a.repository), String(a.title), text(a.body).slice(0, 600)),
  }),
  approve_task: (a, t) => ({
    title: t.approveTask.title,
    request: t.approveTask.request(String(a.id)),
  }),
  update_repository: (a, t, repo) => {
    const { repository, ...patch } = a
    const lines = repoChanges(repo, patch, t.fields)
    return {
      title: t.updateRepository.title,
      request: t.updateRepository.request(
        String(repository),
        lines.length > 0 ? lines.map((l) => `- ${l}`).join('\n') : t.nothingChanges,
      ),
    }
  },
  create_plan: (a, t) => ({
    title: t.createPlan.title,
    request: t.createPlan.request(String(a.repository), text(a.goal).slice(0, 600)),
  }),
  create_plan_issues: (a, t) => ({
    title: t.createPlanIssues.title,
    request: t.createPlanIssues.request(String(a.planId), Boolean(a.start)),
  }),
  resolve_finding: (a, t) => ({
    title: t.resolveFinding.title,
    request:
      t.resolveFinding.actions[text(a.action)] ??
      t.resolveFinding.other(text(a.action), String(a.id)),
  }),
  update_agent_settings: (a, t) => {
    const roles = Object.keys(t.updateAgentSettings.roles) as AgentRole[]
    const name = (role: AgentRole) => t.updateAgentSettings.roles[role]
    const lines = roles
      .filter((role) => role in a && a[role] !== undefined)
      .map((role) =>
        a[role] === null
          ? t.updateAgentSettings.backToDefault(name(role))
          : t.updateAgentSettings.chosen(name(role), String(a[role])),
      )
    const extra = roles.flatMap((role) =>
      (['models', 'efforts'] as const).flatMap((kind) => {
        const map = a[kind] as Record<string, unknown> | undefined
        if (!map || map[role] === undefined) return []
        const what = kind === 'models' ? t.updateAgentSettings.model : t.updateAgentSettings.effort
        return [
          t.updateAgentSettings.detail(
            name(role),
            what,
            map[role] === null ? null : String(map[role]),
          ),
        ]
      }),
    )
    const all = [...lines, ...extra]
    return {
      title: t.updateAgentSettings.title,
      request: t.updateAgentSettings.request(all.length > 0 ? all.join('\n') : t.nothingChanges),
    }
  },
  acknowledge_watch: (a, t) => ({
    title: t.acknowledgeWatch.title,
    request: t.acknowledgeWatch.request(String(a.id)),
  }),
}

/**
 * What the owner is asked to approve, in words, for the tools that change something. `repo` is the
 * repository's current settings, when known, so a save can show what it changes as "before → after".
 */
export function describeApproval(
  toolName: string | undefined,
  input: unknown,
  repo?: RepositoryView,
  t: Approvals = en.approvals,
): Approval {
  const args = (input && typeof input === 'object' ? input : {}) as Args
  const describe = toolName ? APPROVALS[toolName] : undefined
  return describe
    ? describe(args, t, repo)
    : { title: toolName ?? t.fallbackTitle, request: JSON.stringify(input, null, 2) ?? '' }
}

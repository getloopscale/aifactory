import type { ChatSummary, TaskCard } from '../../shared/panel'

import type { Copy } from './copy/en'

/** The key that follows `G` to go to each place, as a person reads a keyboard: `G` then `I` is the inbox. */
export const GO_KEYS: Record<string, string> = {
  i: '/inbox',
  f: '/floor',
  b: '/work',
  p: '/plans',
  r: '/repositories',
  a: '/agents',
  h: '/health',
  c: '/code',
  y: '/history',
  s: '/setup',
}

/** How many tasks the palette lists: the ones that moved last. A longer list makes every key slow. */
export const TASK_LIMIT = 300

export type Command = {
  id: string
  label: string
  hint?: string
  group: string
  /** What a search is matched against, when it is more than the label. */
  searchable?: string
}

/** What choosing a command does: go to an address, or one of the palette's own actions. */
export type CommandTarget = { to: string } | { action: 'theme' | 'language' } | undefined

const ACTIONS = ['theme', 'language'] as const

/** `go:/inbox`, `task:12`, `chat:<id>`, `act:theme`: the id says what the command does, so nothing else keeps it. */
export function targetOf(id: string): CommandTarget {
  const [kind, ...rest] = id.split(':')
  const value = rest.join(':')
  if (kind === 'go') return { to: value }
  if (kind === 'task') return { to: `/tasks/${value}` }
  if (kind === 'chat') return { to: `/chat/${value}` }
  const action = ACTIONS.find((a) => kind === 'act' && a === value)
  return action ? { action } : undefined
}

const keyOf = (path: string) => Object.keys(GO_KEYS).find((key) => GO_KEYS[key] === path)

/** The tasks that moved last, newest first. */
function recent(tasks: TaskCard[]): TaskCard[] {
  return [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, TASK_LIMIT)
}

/**
 * Everything the palette offers, in the order it shows it: the places of the menu with their keys, what the
 * owner can do from anywhere, the tasks that moved last and the conversations.
 */
export function commands(a: {
  t: Copy
  dark: boolean
  tasks?: TaskCard[]
  chats?: ChatSummary[]
}): Command[] {
  const { t } = a
  const place = (path: string, label: string): Command => {
    const key = keyOf(path)
    return {
      id: `go:${path}`,
      label,
      group: t.palette.places,
      hint: key ? t.palette.goKey(key.toUpperCase()) : undefined,
    }
  }
  return [
    place('/inbox', t.places.inbox),
    place('/floor', t.floor.name),
    place('/work', t.places.board),
    place('/plans', t.places.plans),
    place('/code', t.places.code),
    place('/repositories', t.places.repositories),
    place('/agents', t.places.agents),
    place('/health', t.places.health),
    place('/history', t.places.history),
    place('/setup', t.places.setup),
    { id: 'go:/', label: t.menu.newChat, group: t.palette.actions },
    {
      id: 'act:theme',
      label: a.dark ? t.topBar.lightTheme : t.topBar.darkTheme,
      group: t.palette.actions,
    },
    { id: 'act:language', label: t.topBar.switchLanguage, group: t.palette.actions },
    ...recent(a.tasks ?? []).map((task) => {
      const number = task.displayIdentifier ?? `#${task.issueNumber}`
      return {
        id: `task:${task.id}`,
        label: `${number} ${task.title}`,
        hint: task.repository,
        group: t.palette.tasks,
        searchable: `${number} ${task.title} ${task.repository}`,
      }
    }),
    ...(a.chats ?? []).map((chat) => ({
      id: `chat:${chat.id}`,
      label: chat.title || t.palette.untitledChat,
      group: t.palette.chats,
    })),
  ]
}

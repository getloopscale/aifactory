import type { InboxItem } from '../../../src/shared/panel'
import { nextAttention } from '../../../src/app/lib/attention'

export const LISTED = 5

export type MenuEntry =
  | { kind: 'action'; id: 'open' | 'inbox' | 'address' | 'quit'; label: string }
  | { kind: 'item'; label: string; path: string }
  | { kind: 'info'; label: string }
  | { kind: 'toggle'; id: 'login'; label: string }
  | { kind: 'separator' }

/** Where an inbox item leads: its task. */
export const taskPath = (item: InboxItem): string => `/tasks/${item.task.id}`

export const trayTitle = (count: number): string =>
  count === 0 ? 'aifactory: nothing waits' : `aifactory: ${count} waiting`

/** The tray's menu for an inbox: the first five items by summary and a count of the rest. */
export function trayMenu(items: readonly InboxItem[]): MenuEntry[] {
  const menu: MenuEntry[] = [
    { kind: 'action', id: 'open', label: 'Open the panel' },
    {
      kind: 'action',
      id: 'inbox',
      label: items.length === 0 ? 'Open the inbox' : `Open the inbox (${items.length})`,
    },
    { kind: 'separator' },
  ]
  if (items.length === 0) menu.push({ kind: 'info', label: 'Nothing waits for you' })
  for (const item of items.slice(0, LISTED)) {
    menu.push({ kind: 'item', label: item.summary, path: taskPath(item) })
  }
  if (items.length > LISTED) menu.push({ kind: 'info', label: `and ${items.length - LISTED} more` })
  menu.push(
    { kind: 'separator' },
    { kind: 'toggle', id: 'login', label: 'Start at login' },
    { kind: 'action', id: 'address', label: 'Change the address' },
    { kind: 'action', id: 'quit', label: 'Quit' },
  )
  return menu
}

export type Notice = { title: string; body: string; path: string }

/** The notification for what is new since the inbox seen last, by the rule the panel uses. */
export function noticeFor(
  previous: readonly InboxItem[] | null,
  items: readonly InboxItem[],
  now: number,
): Notice | null {
  const next = nextAttention(previous, items, now)
  if (!next) return null
  return {
    title: next.count > 1 ? `${next.count} items wait for you` : 'Something waits for you',
    body: next.first.summary,
    path: taskPath(next.first),
  }
}

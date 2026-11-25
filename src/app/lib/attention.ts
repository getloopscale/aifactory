import type { InboxItem } from '../../shared/panel'

/** What the page says aloud when the inbox gained items: how many, and the first of them. */
export type Announcement = { count: number; first: InboxItem; at: number }

/** An item is its task and its kind: the same task asking for something else is a new item. */
export const identity = (item: InboxItem): string => `${item.task?.id}:${item.kind}`

/**
 * What to announce, given the inbox the page saw last (`null` before the first read) and the one it sees now.
 * The first read announces nothing. An identity is announced once, until it leaves the inbox; when it comes back
 * it is new. Several new items are one announcement.
 */
export function nextAttention(
  previous: readonly InboxItem[] | null,
  items: readonly InboxItem[],
  now: number,
): Announcement | null {
  if (previous === null) return null
  const known = new Set(previous.map(identity))
  const fresh = items.filter((item) => !known.has(identity(item)))
  const first = fresh[0]
  return first ? { count: fresh.length, first, at: now } : null
}

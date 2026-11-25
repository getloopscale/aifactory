import type { PushPayload } from '../../shared/push'
import type { InboxItem } from '../../shared/panel'

/** An item already pushed to one device: its identity and the time it appeared. */
export type Delivered = { identity: string; at: string }

export type PushMessage = { identity: string; at: string; payload: PushPayload }

export const identityOf = (item: Pick<InboxItem, 'kind'> & { task: { id: number } }) =>
  `${item.task.id}:${item.kind}`

const TITLES: Record<InboxItem['kind'], string> = {
  question: 'A task asks a question',
  review: 'A pull request waits for review',
  handoff: 'A task needs a person',
  failed: 'A task failed',
  main_red: 'The default branch went red',
}

/**
 * The messages to send for one device, from the inbox now and what that device already got: one per new
 * identity. An item is new when its identity and time were never sent, so an item that left the inbox
 * and came back (with a later time) is sent again, and one that stayed is not.
 */
export function newMessages(
  inbox: InboxItem[],
  delivered: Delivered[],
  origin: string,
): PushMessage[] {
  const seen = new Set(delivered.map((d) => `${d.identity}@${Date.parse(d.at)}`))
  const out = new Map<string, PushMessage>()
  for (const item of inbox) {
    const identity = identityOf(item)
    const key = `${identity}@${Date.parse(item.at)}`
    if (seen.has(key) || out.has(key)) continue
    out.set(key, {
      identity,
      at: item.at,
      payload: {
        title: TITLES[item.kind],
        body: item.summary,
        url: `${origin}/tasks/${item.task.id}`,
        tag: `task-${item.task.id}`,
      },
    })
  }
  return [...out.values()]
}

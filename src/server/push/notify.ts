import type { PushPayload } from '../../shared/push'
import type { InboxItem } from '../../shared/panel'

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
 * The messages to send for one device, from the inbox now and the identities that device already got: one per
 * new identity. An item's time (`at`, the latest stage event of its task) moves while the item stays, so it is
 * never what makes an item new: an item is new when its identity is not among those the device holds.
 */
export function newMessages(
  inbox: InboxItem[],
  delivered: string[],
  origin: string,
): PushMessage[] {
  const seen = new Set(delivered)
  const out = new Map<string, PushMessage>()
  for (const item of inbox) {
    const identity = identityOf(item)
    if (seen.has(identity) || out.has(identity)) continue
    out.set(identity, {
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

/** The identities a device got that are no longer in the inbox: forgetting them makes a return a new item. */
export function departed(inbox: InboxItem[], delivered: string[]): string[] {
  const present = new Set(inbox.map(identityOf))
  return delivered.filter((identity) => !present.has(identity))
}

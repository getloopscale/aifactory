/**
 * What the factory asks of a tracker (#471). A work item is named by its source and an id that source
 * keeps stable: a GitHub issue is `github` and `owner/repo#12`, a Linear item is `linear` and its UUID.
 * Every call runs on the host; no credential of a source is ever handed to a sandbox.
 */
export type WorkSourceName = 'github' | 'linear'

export type ItemRef = { source: WorkSourceName; id: string }

export type WorkItem = {
  ref: ItemRef
  /** What a person sees: `#12` or `ENG-34`. */
  display: string
  title: string
  body: string
  labels: string[]
  state: 'open' | 'closed' | 'unknown'
  url?: string
}

export type ItemComment = {
  id: string
  body: string
  authorId: string
  authorLogin: string
  createdAt: Date
  /** Whether the author is a member the owner trusts to answer (never the factory itself). */
  trusted: boolean
}

export type Blocker = { ref: ItemRef; display: string; state: 'open' | 'closed' | 'unknown' }

export type WorkSource = {
  readonly name: WorkSourceName
  read(ref: ItemRef): Promise<WorkItem>
  comments(ref: ItemRef): Promise<ItemComment[]>
  comment(ref: ItemRef, body: string): Promise<void>
  /** What blocks the item. A relation that cannot be read is `unknown`, never `closed`. */
  blockers(ref: ItemRef): Promise<Blocker[]>
  /** Marks the item done (closes a GitHub issue, moves a Linear item to its completed state). */
  close(ref: ItemRef, comment?: string): Promise<void>
}

export const itemKey = (ref: ItemRef): string => `${ref.source}:${ref.id}`

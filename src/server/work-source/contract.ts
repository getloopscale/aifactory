/**
 * What the factory asks of the tracker its work comes from (#471). GitHub issues is the first
 * implementation (`github.ts`), Linear the second (`../linear/source.ts`). Everything here runs on the
 * host: a sandbox never receives a tracker credential.
 */

export type WorkSourceKind = 'github' | 'linear'

/** An item of a tracker: `id` is the tracker's own key, `identifier` what a person reads (`org/repo#4`, `ENG-12`). */
export type WorkItem = {
  source: WorkSourceKind
  id: string
  identifier: string
  url: string
  title: string
  body: string
  labels: string[]
  state: 'open' | 'closed'
}

export type WorkComment = {
  id: string
  body: string
  author: string
  createdAt: Date
  /** Whether the author may answer for the owner: a member of the repository or of the workspace. Never the factory. */
  trusted: boolean
}

export type WorkSource = {
  readonly kind: WorkSourceKind
  /** Reads an item by its id. A failed read throws; it is never an empty item. */
  read(id: string): Promise<WorkItem>
  /** The comments made on an item since a time, oldest first. Every page; a failure throws. */
  listComments(id: string, since: Date): Promise<WorkComment[]>
  /** The identifiers of the open items that block this one. */
  openBlockers(item: WorkItem): Promise<string[]>
  /** Comments on an item (a question, the pull request, the release) and returns the comment's id. */
  comment(id: string, body: string): Promise<string>
  /** Moves the item to its done state: closes a GitHub issue, completes a Linear one. */
  close(id: string): Promise<void>
}

/** An answer is a trusted person's comment, never one the factory wrote itself. */
export const answers = (comments: WorkComment[]): WorkComment[] => comments.filter((c) => c.trusted)

/** Code mode: a session with an agent on a repository, and the numbered events it produces. */

export const CODE_MODES = ['ask', 'plan', 'code'] as const
export type CodeMode = (typeof CODE_MODES)[number]

export const CODE_STATES = [
  'idle',
  'queued',
  'starting',
  'running',
  'waiting_input',
  'stopped',
  'ended',
  'failed',
] as const
export type CodeState = (typeof CODE_STATES)[number]

export const CODE_EVENT_KINDS = [
  'user_message',
  'agent_message',
  'tool_use',
  'tool_result',
  'error',
  'plan',
  'state',
  'cost',
] as const
export type CodeEventKind = (typeof CODE_EVENT_KINDS)[number]

export type CodeSession = {
  id: string
  title: string
  /** Full name, `owner/name`. */
  repository: string
  baseBranch: string
  workBranch: string
  harness: string
  model: string | null
  mode: CodeMode
  state: CodeState
  sandboxId: string | null
  snapshotId: string | null
  agentSessionId: string | null
  /** The harness that produced `agentSessionId`. */
  agentSessionHarness: string | null
  /** The draft pull request opened from the work branch, once there is one. */
  pullRequestUrl: string | null
  pullRequestNumber: number | null
  createdAt: Date
  updatedAt: Date
}

export type CodeEvent = {
  sessionId: string
  seq: number
  kind: CodeEventKind
  tool: string | null
  content: string
  at: Date
}

/** A session as the API sends it: JSON carries dates as strings. */
export type CodeSessionWire = Omit<CodeSession, 'createdAt' | 'updatedAt'> & {
  createdAt: string
  updatedAt: string
}

/** An event as the API and the stream send it. */
export type CodeEventWire = Omit<CodeEvent, 'at'> & { at: string }

/** A page of a session's events after a `seq`, oldest first. */
export type CodeEventPage = { events: CodeEventWire[]; more: boolean }

export const toSessionWire = (s: CodeSession): CodeSessionWire => ({
  ...s,
  createdAt: s.createdAt.toISOString(),
  updatedAt: s.updatedAt.toISOString(),
})

export const toEventWire = (e: CodeEvent): CodeEventWire => ({ ...e, at: e.at.toISOString() })

/** One line of a hunk, with the number it has on each side it appears on. */
export type CodeDiffLine =
  | { kind: 'context'; text: string; oldLine: number; newLine: number }
  | { kind: 'add'; text: string; newLine: number }
  | { kind: 'del'; text: string; oldLine: number }

export type CodeDiffHunk = { header: string; lines: CodeDiffLine[] }

export type CodeDiffFile = {
  path: string
  added: number
  removed: number
  /** A binary file has counts of 0 and no hunks. */
  binary: boolean
  hunks: CodeDiffHunk[]
}

/** What a workspace changed against the merge base with its base branch. */
export type CodeDiff = { files: CodeDiffFile[] }

/** The diff route's answer: `live` when it was read from the running workspace, else the last one stored. */
export type CodeDiffResponse = { diff: CodeDiff; live: boolean; capturedAt: string | null }

/** The files of a workspace: tracked and untracked, without what git excludes by default. */
export type CodeFilesResponse = { files: string[] }

/** One file's text, cut at `limit` bytes; `truncated` says it was longer. */
export type CodeFileResponse = {
  path: string
  content: string
  truncated: boolean
  limit: number
}

/** The pull request a session opened: the same one every time it is asked again. */
export type CodePullRequestResponse = { number: number; url: string; draft: boolean }

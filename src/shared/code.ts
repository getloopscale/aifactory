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

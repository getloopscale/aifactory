import { vi } from 'vitest'

import type { CoordinatorActionView, InboxItem, TaskCard } from '../shared/panel'

/** A task card as the panel API returns it, with only what a test says about it changed. */
export const card = (over: Partial<TaskCard> = {}): TaskCard => ({
  id: 1,
  repository: 'paulo/app',
  issueNumber: 7,
  title: 'Add truncate',
  stage: 'build',
  column: 'working',
  pullRequestUrl: null,
  headSha: null,
  costUsd: 0,
  attempts: 1,
  createdAt: '2026-11-04T10:00:00Z',
  updatedAt: '2026-11-04T10:05:00Z',
  leadTime: { minutes: 5, status: 'on_track', running: true },
  approved: false,
  integrated: false,
  waitingForChecks: false,
  waitingOnBase: null,
  returned: null,
  queue: null,
  resolved: false,
  retryable: null,
  retryAt: null,
  preRelease: null,
  release: null,
  mainRed: false,
  releaseWait: null,
  working: null,
  lastAgent: null,
  ...over,
})

/** An inbox item about `task`. */
export const inboxItem = (
  task: TaskCard,
  over: Partial<Omit<InboxItem, 'task'>> = {},
): InboxItem => ({
  task,
  kind: 'question',
  summary: 'Which database?',
  at: '2026-11-04T10:05:00Z',
  ...over,
})

/** A decision of the coordinator. */
export const decision = (over: Partial<CoordinatorActionView> = {}): CoordinatorActionView => ({
  id: 1,
  taskId: 1,
  repository: 'paulo/app',
  issueNumber: 7,
  title: 'Add truncate',
  exceptionKind: 'checks_red',
  action: 'send_back',
  outcome: 'applied',
  reason: 'The checks failed on the head',
  draft: null,
  at: '2026-11-04T10:05:00Z',
  ...over,
})

/**
 * Answers `fetch` by path: a path in `routes` gets its value as JSON (or the `Response` itself, for a failure),
 * and any other path gets a 404, as the server would answer.
 */
export function servePanel(routes: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = String(url)
      if (!(path in routes)) return Response.json({ error: 'not found' }, { status: 404 })
      const answer = routes[path]
      return answer instanceof Response ? answer.clone() : Response.json(answer)
    }),
  )
}

/** A refusal of the server with a message a person reads. */
export const refusal = (message: string) => Response.json({ message }, { status: 500 })

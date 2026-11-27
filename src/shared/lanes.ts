import type { TaskCard } from './panel'

/**
 * The six lanes the board shows. The server still tells nine columns apart (`Column`), which the assistants and
 * the floor read; a lane groups them by who has the task now, and the card says the rest.
 */
export type Lane = 'todo' | 'needs_you' | 'running' | 'ready' | 'done' | 'cancelled'

export const LANES: Lane[] = ['todo', 'needs_you', 'running', 'ready', 'done', 'cancelled']

/** The lanes whose tasks ended. */
export const ENDED_LANES: readonly Lane[] = ['done', 'cancelled']

export function laneOf(task: Pick<TaskCard, 'stage' | 'column'>): Lane {
  if (task.stage === 'cancelled') return 'cancelled'
  switch (task.column) {
    case 'queued':
      return 'todo'
    case 'waiting':
    case 'attention':
      return 'needs_you'
    case 'working':
    case 'retrying':
    case 'merge':
      return 'running'
    case 'review':
      return 'ready'
    case 'released':
    case 'resolved':
      return 'done'
  }
}

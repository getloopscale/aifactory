import type { TaskCard } from './panel'

/**
 * The lanes the board shows. `needs_you` is beside the flow: a task there is stopped until the owner acts. The
 * five after it are the flow, left to right: to do (waiting for a run), with an agent, on its way to the integration
 * branch, on it and waiting for a release, released. The server still tells nine columns apart (`Column`), which
 * the assistants and the floor read; a lane groups them by where the task is, and the card says the rest.
 */
export type Lane =
  'needs_you' | 'todo' | 'building' | 'integrating' | 'awaiting_release' | 'released' | 'cancelled'

export const LANES: Lane[] = [
  'needs_you',
  'todo',
  'building',
  'integrating',
  'awaiting_release',
  'released',
  'cancelled',
]

/** The lanes of the flow, in the order a task goes through them. */
export const FLOW_LANES: readonly Lane[] = [
  'todo',
  'building',
  'integrating',
  'awaiting_release',
  'released',
]

/** The lanes whose tasks ended. */
export const ENDED_LANES: readonly Lane[] = ['released', 'cancelled']

export function laneOf(task: Pick<TaskCard, 'stage' | 'column'>): Lane {
  if (task.stage === 'cancelled') return 'cancelled'
  switch (task.column) {
    // A task that will run again by itself waits for a run, like one that never ran.
    case 'queued':
    case 'retrying':
      return 'todo'
    case 'waiting':
    case 'attention':
      return 'needs_you'
    case 'working':
      return 'building'
    case 'merge':
      return 'integrating'
    case 'review':
      return 'awaiting_release'
    case 'released':
    case 'resolved':
      return 'released'
  }
}

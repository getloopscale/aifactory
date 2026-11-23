import type { TagWorkflowRun } from '../github/pulls'

/**
 * How long a pushed tag may go with no workflow run before the publication is called failed: a tag that
 * starts nothing publishes nothing, and waiting for it forever would hold the tasks and their issues.
 */
export const NO_RUN_MS = 30 * 60 * 1000

/** Conclusions of a finished run that are not a failure: the workflow did what it was asked to. */
const PASSED = new Set(['success', 'neutral', 'skipped'])

export type TagStep =
  | { kind: 'published'; detail: string }
  | { kind: 'failed'; detail: string }
  | { kind: 'wait'; detail: string }

/**
 * Reads the workflow runs the tag started: only the ones on the commit the tag points at count. Every run
 * must have finished and passed for the version to be published; one that failed fails the publication
 * with its name and link; one still running, or none yet, waits (none for `NO_RUN_MS` fails).
 */
export function decideTagPublication(input: {
  tag: string
  sha: string
  runs: TagWorkflowRun[]
  startedAt: Date
  now: Date
}): TagStep {
  const { tag } = input
  const runs = input.runs.filter((r) => r.headSha === input.sha)
  if (runs.length === 0) {
    const waited = input.now.getTime() - input.startedAt.getTime()
    return waited >= NO_RUN_MS
      ? {
          kind: 'failed',
          detail: `no workflow ran for ${tag} within ${Math.round(NO_RUN_MS / 60000)} minutes, so nothing published it`,
        }
      : { kind: 'wait', detail: `waiting for the workflow run of ${tag} to start` }
  }
  const failed = runs.filter((r) => r.status === 'completed' && !PASSED.has(r.conclusion ?? ''))
  if (failed.length > 0) {
    const what = failed.map((r) => `${r.name} (${r.conclusion ?? 'no conclusion'}: ${r.url})`)
    return { kind: 'failed', detail: `the workflow run of ${tag} failed: ${what.join('; ')}` }
  }
  const running = runs.filter((r) => r.status !== 'completed')
  if (running.length > 0) {
    return {
      kind: 'wait',
      detail: `waiting for the workflow run of ${tag} to finish: ${running.map((r) => r.name).join(', ')}`,
    }
  }
  return {
    kind: 'published',
    detail: `published ${tag}: ${runs.map((r) => r.name).join(', ')} succeeded`,
  }
}

/**
 * JobRegistry augmentation: typed `ctx.queue.enqueue`. The registry lives in `@getloopscale/loopzero/server/jobs`,
 * the module `QueueClient` comes from (usetheokit/theokit#1074).
 *
 * Each job is a file `src/server/jobs/<name>.ts` exporting `defineJob('<name>', ...)`, with its
 * input listed here.
 */
declare module '@getloopscale/loopzero/server/jobs' {
  interface JobRegistry {
    /** Runs one task end to end: sandbox, agent, push of `factory/<issue>`. */
    'run-task': {
      taskId: number
      decisionId?: number
      feedback?: string
      resume?: boolean
      mergeBase?: boolean
      fromReview?: boolean
      conversation?: boolean
    }
    /**
     * Takes work the review approved, waiting in `merge`, to its pull request and the integration branch, at
     * the approved commit.
     */
    'merge-task': { taskId: number; sha: string }
    /** Continues a task whose question was answered, from the snapshot taken when it was asked. */
    'resume-task': { taskId: number; questionId: number }
    /** Delivers the owner's pending messages to a stopped task's agent, oldest first, one writer per task. */
    conversation: { taskId: number }
    /** Runs one turn of a code session: its oldest unanswered message, one writer per session. */
    'code-turn': { sessionId: string }
    /** Sends one finished agent pass to Looptrace over OTLP; queued only when FACTORY_TRACE_ENDPOINT is set. */
    'export-trace': { runId: number }
    /** Has an agent read a repository and split a goal into issues. */
    'plan-run': { planId: number }
    /** Reviews a pull request the factory did not open, at one head commit, and posts one review. */
    'review-pull-request': { reviewId: number }
    /**
     * Runs the checks proposed for a repository in a sandbox and saves the ones that pass, as its checks
     * or its integration checks.
     */
    'prove-checks': { repository: string; at: string; kind?: 'checks' | 'integration' }
  }
}

// `ctx.queue` exists on every route because `loopzero.config.ts` sets `jobs.backend`.
declare module '@getloopscale/loopzero/server/define' {
  interface RouteContext {
    queue: import('@getloopscale/loopzero/server/jobs').QueueClient
  }
}

export {}

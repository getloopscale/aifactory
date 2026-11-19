/**
 * A process started with `FACTORY_WORKER_ONLY=1` only runs jobs. The framework's worker runs one job at a
 * time, so more runs at once means more processes, and the crons (the watcher of the default branch, the
 * supervisor, the poller of answers, the catch-up, the retries) must run in exactly one of them.
 */
export const isWorkerOnly = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.FACTORY_WORKER_ONLY === '1'

/**
 * A process started with `FACTORY_SERVER_ONLY=1` serves the panel, the webhook and the crons, and takes no job.
 * It still has the job backend, to queue jobs and to lock cron ticks. Holding no run, it stops in seconds, so a
 * deploy never leaves the factory without its crons while a run drains (2026-11-19: 34 minutes without one).
 */
export const isServerOnly = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.FACTORY_SERVER_ONLY === '1'

/**
 * A cron handler that runs only in the main process. The check lives here, tested once, instead of as a
 * branch in each handler, where it would raise the complexity of code the tests do not reach.
 */
export const mainProcessOnly =
  <T>(handler: () => Promise<T>, env: NodeJS.ProcessEnv = process.env) =>
  async (): Promise<T | undefined> =>
    isWorkerOnly(env) ? undefined : handler()

/** The lock `theokit start` asks before each cron tick (`cron.lock` in `theo.config.ts`). */
export type CronLock = { acquire(name: string, scheduledAt: Date): Promise<boolean> }

/**
 * The cron lock of the factory. Every process schedules the crons, and the shared lock gives each tick to
 * one of them, so a worker-only process that took a tick and did nothing left that minute without its cron.
 * A worker-only process never takes one; the main processes share the tick through the lock.
 */
export const mainProcessCronLock = (
  shared: CronLock,
  env: NodeJS.ProcessEnv = process.env,
): CronLock => ({
  acquire: async (name, scheduledAt) =>
    isWorkerOnly(env) ? false : shared.acquire(name, scheduledAt),
})

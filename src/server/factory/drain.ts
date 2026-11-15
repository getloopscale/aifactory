import { MAX_RUN_MS } from './run-limit'

/**
 * How long a restart waits for the run in progress before `theokit start` gives up on it
 * (`jobs.worker.shutdownTimeoutMs`, usetheokit/theokit#1292). A run's sandbox stops it after its limit, at most
 * `MAX_RUN_MS` (the owner sets it per repository), so two minutes more lets any run finish and be recorded, and a
 * deploy never cuts an agent's work. The units' `TimeoutStopSec` is set above it; drain.test.ts keeps them in line.
 */
export const JOB_SHUTDOWN_WAIT_MS = MAX_RUN_MS + 2 * 60_000

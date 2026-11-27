import { PostgresJobBackend } from '@getloopscale/loopzero/server/jobs'
import { getStorageManager } from '@getloopscale/loopzero/server/storage'

import { createPool } from '../db'
import { DATABASE_NAME } from '../db/config'

let backend: PostgresJobBackend | undefined

/**
 * The one job backend, shared by `loopzero.config.ts` and by code that has to queue a job without a
 * request: a job or a cron has no `ctx.queue` (usetheokit/theokit#1150), so it writes through
 * the backend itself.
 */
export function jobBackend(): PostgresJobBackend {
  return (backend ??= PostgresJobBackend.fromStorageManager(
    getStorageManager(),
    DATABASE_NAME,
    createPool,
  ))
}

/**
 * The delay a short job is queued with so that it goes ahead of every queued run. Workers take the job whose
 * `available_at` is earliest, so a merge or a resume, which take seconds and deliver or continue work, waited
 * behind every older `run-task`, each up to an hour: on 2026-11-18 four approved tasks waited over an hour to merge.
 * LoopZero has no job priority (usetheokit/theokit#2117); its insert takes a negative delay as a time in the past.
 */
export const AHEAD_OF_RUNS = { delaySeconds: -10 * 365 * 86_400 } as const

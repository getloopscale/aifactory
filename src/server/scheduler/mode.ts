import { modeFromEnv, type CoordinatorMode } from '../coordinator/mode'

/**
 * How far the scheduler goes, as for the coordinator: `off` does nothing, `trial` (the default) decides and
 * records without changing a job, a task or an issue, `auto` applies what it decides.
 */
export type SchedulerMode = CoordinatorMode

export const schedulerModeFromEnv = (env: NodeJS.ProcessEnv): SchedulerMode =>
  modeFromEnv(env, 'FACTORY_SCHEDULER_MODE')

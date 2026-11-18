import { modeFromEnv, type CoordinatorMode } from '../coordinator/mode'

/**
 * How far the scheduler goes, as for the coordinator: `off` does nothing, `trial` (the default) decides and
 * records without changing a job, a task or an issue, `auto` applies what it decides.
 */
export type SchedulerMode = CoordinatorMode

/** The mode of the order of the queue (`FACTORY_SCHEDULER_MODE`). */
export const schedulerModeFromEnv = (env: NodeJS.ProcessEnv): SchedulerMode =>
  modeFromEnv(env, 'FACTORY_SCHEDULER_MODE')

/**
 * The mode of the readiness judge (`FACTORY_READINESS_MODE`), apart from the order's: the order is a sort the
 * tests prove, while the judge is a model whose verdicts are compared with what became of the tasks before it
 * may hold one back.
 */
export const readinessModeFromEnv = (env: NodeJS.ProcessEnv): SchedulerMode =>
  modeFromEnv(env, 'FACTORY_READINESS_MODE')

/** What each step of a pass may do. */
export type SchedulerModes = { order: SchedulerMode; readiness: SchedulerMode }

/** Both modes, as the environment sets them. */
export const schedulerModesFromEnv = (env: NodeJS.ProcessEnv): SchedulerModes => ({
  order: schedulerModeFromEnv(env),
  readiness: readinessModeFromEnv(env),
})

/** Whether a pass has nothing to do: both steps are off. */
export const passIsOff = (modes: SchedulerModes): boolean =>
  modes.order === 'off' && modes.readiness === 'off'

/**
 * How far the coordinator goes: `off` does nothing, `trial` decides and records without applying anything,
 * `auto` applies what it decides. The scheduler (`scheduler/`) has the same three modes.
 */
export type CoordinatorMode = 'off' | 'trial' | 'auto'

const MODES: readonly CoordinatorMode[] = ['off', 'trial', 'auto']

/** `trial` unless `variable` says otherwise, and an unknown word is an error, not a default. */
export function modeFromEnv(env: NodeJS.ProcessEnv, variable: string): CoordinatorMode {
  const mode = env[variable] || 'trial'
  const known = MODES.find((m) => m === mode)
  if (!known) {
    throw new Error(`${variable} must be off, trial or auto, got ${mode}`)
  }
  return known
}

export const coordinatorModeFromEnv = (env: NodeJS.ProcessEnv): CoordinatorMode =>
  modeFromEnv(env, 'FACTORY_COORDINATOR_MODE')

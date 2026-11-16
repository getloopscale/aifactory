/**
 * How far the coordinator goes: `off` does nothing, `trial` decides and records without applying anything,
 * `auto` applies what it decides.
 */
export type CoordinatorMode = 'off' | 'trial' | 'auto'

const MODES: readonly CoordinatorMode[] = ['off', 'trial', 'auto']

/** `trial` unless the environment says otherwise, and an unknown word is an error, not a default. */
export function coordinatorModeFromEnv(env: NodeJS.ProcessEnv): CoordinatorMode {
  const mode = env.FACTORY_COORDINATOR_MODE || 'trial'
  const known = MODES.find((m) => m === mode)
  if (!known) {
    throw new Error(`FACTORY_COORDINATOR_MODE must be off, trial or auto, got ${mode}`)
  }
  return known
}

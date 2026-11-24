import type { EngineModels } from '../../shared/panel'

import type { HarnessOptions } from './engine-models'
import { securityEffort } from './engine-models'

/**
 * The tools of the security agent (#241): reads only. A tool that writes a file or runs a command is not
 * here, and the agent runs under `onlyTools(SECURITY_TOOLS)` like the reviewer.
 */
export const SECURITY_TOOLS = [
  'read_file',
  'list_files',
  'search_files',
  'knowledge_search',
  'knowledge_read',
]

/**
 * What the security agent runs with: the effort is the highest its engine offers for the model, whatever an
 * environment or a setting says, so it cannot be lowered. `undefined` when the engine's highest cannot be
 * established: the security review does not run on a default.
 */
export function securityOptions(
  efforts: string[],
  chosen: { model?: string } = {},
): HarnessOptions | undefined {
  const effort = securityEffort(efforts)
  return effort ? { ...(chosen.model ? { model: chosen.model } : {}), effort } : undefined
}

/**
 * The effort levels the security agent may be pinned to: those of the chosen model, or, with none chosen, the
 * levels every model of the engine offers, since the engine's own default model is not known. An engine that
 * lists no model offers none here, and the security review does not run on a guess.
 */
export function securityEfforts(catalog: EngineModels | undefined, model?: string): string[] {
  if (!catalog) return []
  if (model) return catalog.models.find((m) => m.id === model)?.efforts ?? []
  if (catalog.models.length === 0) return catalog.efforts
  return catalog.models
    .map((m) => m.efforts)
    .reduce((common, efforts) => common.filter((e) => efforts.includes(e)))
}

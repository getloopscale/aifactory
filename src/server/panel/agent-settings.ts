import type { AgentSettings } from '../../shared/panel'
import type { Database } from '../db'
import {
  agentSettings,
  listSettingChanges,
  saveChosen,
  SettingRefused,
  type AgentSettingsPatch,
} from '../factory/settings'

import { ActionRefused } from './actions'

/** Saves which agent builds, plans and reviews, and answers with what stands now. A refusal is the owner's to fix. */
export async function changeAgentSettings(
  db: Database,
  patch: AgentSettingsPatch,
  env: NodeJS.ProcessEnv = process.env,
  read?: (path: string) => string,
): Promise<AgentSettings> {
  try {
    await saveChosen(db, patch, env, read)
  } catch (error) {
    if (error instanceof SettingRefused) throw new ActionRefused(error.message)
    throw error
  }
  return agentSettings(db, env, read)
}

/** What changed in the agent settings, oldest first. */
export const agentSettingHistory = listSettingChanges

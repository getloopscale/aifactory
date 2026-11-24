import { route } from 'theokit/server/define'

import { getDb } from '../../db'
import {
  linearSettingsSchema,
  readLinearSettings,
  saveLinearSettings,
} from '../../ingest/linear-settings'
import { ownerOnly } from '../../panel/policy'

/** The Linear label and the team-to-repository mapping the owner set, or none. */
export const GET = route()
  .policy(ownerOnly)
  .handler(async () => ({ settings: (await readLinearSettings(getDb())) ?? null }))
  .build()

/**
 * Saves them. A Linear item is taken only for a mapped team whose repository is enabled, so this grants
 * nothing alone: `repository.enabled` is still checked when a delivery is recorded.
 */
export const PUT = route()
  .policy(ownerOnly)
  .body(linearSettingsSchema)
  .handler(async ({ body }) => ({ settings: await saveLinearSettings(getDb(), body) }))
  .build()

import { inArray } from 'drizzle-orm'
import { z } from 'zod'

import type { Database } from '../db'
import { setting } from '../db/schema'

import type { LinearSettings } from './decide-linear'

export const LINEAR_LABEL_KEY = 'linear.label_id'
export const LINEAR_TEAMS_KEY = 'linear.teams'

/** What the owner may save: ids Linear keeps, and `owner/repo` names. */
export const linearSettingsSchema = z.object({
  labelId: z.string().trim().min(1).max(100),
  teams: z
    .record(z.string().trim().min(1).max(100), z.string().regex(/^[\w.-]+\/[\w.-]+$/))
    .refine((teams) => Object.keys(teams).length <= 100, 'too many teams'),
})

/** The saved settings, or nothing when the owner has not set a label (no Linear item is taken then). */
export async function readLinearSettings(db: Database): Promise<LinearSettings | undefined> {
  const rows = await db
    .select()
    .from(setting)
    .where(inArray(setting.key, [LINEAR_LABEL_KEY, LINEAR_TEAMS_KEY]))
  const label = rows.find((r) => r.key === LINEAR_LABEL_KEY)?.value
  if (!label) return undefined
  let teams: unknown = {}
  try {
    teams = JSON.parse(rows.find((r) => r.key === LINEAR_TEAMS_KEY)?.value ?? '{}')
  } catch {
    // A mapping that cannot be read maps nothing: no item is taken.
  }
  const parsed = linearSettingsSchema.shape.teams.safeParse(teams)
  return { labelId: label, teams: parsed.success ? parsed.data : {} }
}

export async function saveLinearSettings(db: Database, value: LinearSettings, now = new Date()) {
  const parsed = linearSettingsSchema.parse(value)
  for (const [key, text] of [
    [LINEAR_LABEL_KEY, parsed.labelId],
    [LINEAR_TEAMS_KEY, JSON.stringify(parsed.teams)],
  ] as const) {
    await db
      .insert(setting)
      .values({ key, value: text, updatedAt: now })
      .onConflictDoUpdate({ target: setting.key, set: { value: text, updatedAt: now } })
  }
  return parsed
}

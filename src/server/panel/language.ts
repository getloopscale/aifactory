// The language the owner chose for the panel, kept in `setting` so it follows them from one browser to another.
import { eq } from 'drizzle-orm'

import { type Database } from '../db'
import { setting } from '../db/schema'

export const LANGUAGES = ['en', 'pt-BR'] as const
export type Language = (typeof LANGUAGES)[number]

export const LANGUAGE_SETTING_KEY = 'panel.language'

/** A stored value that is one of the languages the panel speaks, or nothing. */
export function parseLanguage(value: string | null | undefined): Language | undefined {
  return LANGUAGES.find((language) => language === value)
}

/** The saved choice; a missing or unknown value is no choice, so the browser's language decides. */
export async function readLanguage(db: Database): Promise<Language | undefined> {
  const [row] = await db.select().from(setting).where(eq(setting.key, LANGUAGE_SETTING_KEY))
  return parseLanguage(row?.value)
}

export async function saveLanguage(db: Database, language: Language, now = new Date()) {
  await db
    .insert(setting)
    .values({ key: LANGUAGE_SETTING_KEY, value: language, updatedAt: now })
    .onConflictDoUpdate({ target: setting.key, set: { value: language, updatedAt: now } })
  return { language }
}

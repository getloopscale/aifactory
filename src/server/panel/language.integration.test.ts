import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from '@getloopscale/loopzero/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { setting } from '../db/schema'

import { LANGUAGE_SETTING_KEY, readLanguage, saveLanguage } from './language'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getDb().delete(setting).where(eq(setting.key, LANGUAGE_SETTING_KEY))
})
afterAll(async () => {
  await getDb().delete(setting).where(eq(setting.key, LANGUAGE_SETTING_KEY))
})

describe('the language of the panel, kept in `setting`', () => {
  it('is no choice until the owner makes one', async () => {
    expect(await readLanguage(getDb())).toBeUndefined()
  })

  it('is read back as saved, and the last choice wins', async () => {
    await saveLanguage(getDb(), 'pt-BR')
    expect(await readLanguage(getDb())).toBe('pt-BR')
    await saveLanguage(getDb(), 'en')
    expect(await readLanguage(getDb())).toBe('en')
    const rows = await getDb().select().from(setting).where(eq(setting.key, LANGUAGE_SETTING_KEY))
    expect(rows).toHaveLength(1)
  })

  it('is no choice when the stored value is not a language the panel speaks', async () => {
    await getDb()
      .insert(setting)
      .values({ key: LANGUAGE_SETTING_KEY, value: 'klingon', updatedAt: new Date() })
    expect(await readLanguage(getDb())).toBeUndefined()
  })
})

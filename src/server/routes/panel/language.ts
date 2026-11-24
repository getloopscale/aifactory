import { route } from 'theokit/server/define'
import { z } from 'zod'

import { getDb } from '../../db'
import { LANGUAGES, readLanguage, saveLanguage } from '../../panel/language'
import { ownerOnly } from '../../panel/policy'

/** The language the owner chose for the panel, or none when they never did. */
export const GET = route()
  .policy(ownerOnly)
  .handler(async () => ({ language: (await readLanguage(getDb())) ?? null }))
  .build()

/** Saves the owner's choice of language. */
export const PUT = route()
  .policy(ownerOnly)
  .body(z.object({ language: z.enum(LANGUAGES) }))
  .handler(async ({ body }) => saveLanguage(getDb(), body.language))
  .build()

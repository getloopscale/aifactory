import { route } from '@getloopscale/loopzero/server/define'

import { getDb } from '../../db'
import { githubAppFromEnv } from '../../factory/deps'
import { readLanguage } from '../../panel/language'

let cached: { name: string | undefined; at: number } | undefined

/** The GitHub account that owns the App, which is the owner of the factory. Looked up rarely, never fatal. */
async function ownerName(): Promise<string | undefined> {
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.name
  let name: string | undefined
  try {
    name = await githubAppFromEnv().owner()
  } catch {
    name = undefined
  }
  cached = { name, at: Date.now() }
  return name
}

/** The language the owner saved, or none; a database that does not answer is no choice, never a failed page. */
async function savedLanguage() {
  try {
    return await readLanguage(getDb())
  } catch {
    return undefined
  }
}

/** Whether this browser is signed in, so the interface knows whether to show the login, and who the owner is. */
export const GET = route()
  .policy('public')
  .handler(async ({ ctx }) => {
    const owner = (ctx as { subject?: { id?: string } }).subject?.id === 'owner'
    return owner ? { owner, name: await ownerName(), language: await savedLanguage() } : { owner }
  })
  .build()

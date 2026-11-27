// Helpers of scripts/deploy.sh for the database it evaluates against and the migrations it applies.
//
//   node scripts/deploy-db.mjs names <database url>         user, database, temporary database, temporary url
//   node scripts/deploy-db.mjs pending <applied created_at>  the journal's migrations Drizzle has not applied
//
// Drizzle applies a migration when its journal `when` is later than the newest `created_at` in
// drizzle.__drizzle_migrations, so that is the rule used here, not the file number.
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

/** The URL, user and database the evaluation copy gets: the same server, a database of its own name. Never prints the password. */
export function evaluationDatabase(url, suffix = randomBytes(4).toString('hex')) {
  const parsed = new URL(url)
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  if (!/^[A-Za-z0-9_]+$/.test(database))
    throw new Error('the database name must be letters, digits and _')
  // The factory's own role when the URL names none, as the busy check above it assumes.
  const user = decodeURIComponent(parsed.username) || 'factory'
  if (!/^[A-Za-z0-9_]+$/.test(user))
    throw new Error('the database user must be letters, digits and _')
  const temporary = `${database}_eval_${suffix}`
  parsed.pathname = `/${temporary}`
  return { user, database, temporary, url: parsed.toString() }
}

/** Names of the journal entries newer than `applied` (the newest created_at in production, 0 for none), in order. */
export function pendingMigrations(journal, applied) {
  return journal.entries.filter((e) => e.when > applied).map((e) => e.tag)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, arg] = process.argv.slice(2)
  try {
    if (command === 'names') {
      const n = evaluationDatabase(arg)
      console.log([n.user, n.database, n.temporary, n.url].join('\n'))
    } else if (command === 'pending') {
      const applied = Number(arg)
      if (!Number.isFinite(applied)) throw new Error('the applied migrations could not be read')
      const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'))
      console.log(pendingMigrations(journal, applied).join('\n'))
    } else throw new Error(`unknown command ${command}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

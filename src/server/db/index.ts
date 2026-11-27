import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { getStorageManager, type PostgresFactory } from '@getloopscale/loopzero/server/storage'

import { DATABASE_NAME, LEASE_DATABASE_NAME, readLeaseUrl } from './config'
import * as schema from './schema'

export { DatabaseConfigError, readDatabaseUrl } from './config'

export type Database = NodePgDatabase<typeof schema>

/**
 * The process-wide pool, owned by LoopZero's storage manager so that it is drained on shutdown
 * and survives Postgres dropping an idle connection (usetheokit/theokit#1019). Created on first
 * use, so importing this module never connects.
 */
export function getPool(): pg.Pool {
  return getStorageManager().usePostgres(DATABASE_NAME, createPool) as pg.Pool
}

/** How the storage manager builds the pool: from the server and database in `loopzero.config.ts`. */
export const createPool: PostgresFactory = (server, db) => {
  const { host, port, user, password } = server
  return new pg.Pool({ host, port, user, password, database: db.database, ...db.pool })
}

export function getDb(): Database {
  return drizzle(getPool(), { schema })
}

/**
 * Where a sandbox lease is recorded: the lease database of a deploy's evaluation when one is configured, else
 * the main one. `main` and `lease` open the databases, so a caller can tell which one was chosen.
 */
export function getLeaseDb(
  env: NodeJS.ProcessEnv = process.env,
  main: () => Database = getDb,
  lease: () => Database = () =>
    drizzle(getStorageManager().usePostgres(LEASE_DATABASE_NAME, createPool) as pg.Pool, {
      schema,
    }),
): Database {
  return readLeaseUrl(env) ? lease() : main()
}

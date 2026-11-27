import type { StorageConfig } from '@getloopscale/loopzero/server/storage'
import { z } from 'zod'

const databaseEnvSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
})

/** Thrown when `DATABASE_URL` is set but is not a usable postgres:// URL. */
export class DatabaseConfigError extends Error {
  constructor(detail: string) {
    super(`DATABASE_URL is missing or not a postgres:// URL: ${detail}`)
    this.name = 'DatabaseConfigError'
  }
}

/** Reads and validates the database URL, failing before any connection is attempted. */
export function readDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const parsed = databaseEnvSchema.safeParse(env)
  if (!parsed.success) {
    throw new DatabaseConfigError(z.prettifyError(parsed.error))
  }
  return parsed.data.DATABASE_URL
}

/** The name `usePostgres` takes, and the key of the database in `loopzero.config.ts`. */
export const DATABASE_NAME = 'main'

/**
 * LoopZero's `storage` block takes credentials as fields and reads no connection string, so the
 * URL the rest of the tooling shares (`drizzle-kit`, `.env`) is split here, once.
 */
export function storageFromUrl(url: string, leaseUrl?: string): StorageConfig {
  const parsed = new URL(url)
  const server = (u: URL) => ({
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
  })
  const config: StorageConfig = {
    servers: { primary: server(parsed) },
    databases: {
      [DATABASE_NAME]: {
        server: 'primary',
        database: decodeURIComponent(parsed.pathname.slice(1)),
      },
    },
  }
  if (!leaseUrl) return config
  const lease = new URL(leaseUrl)
  return {
    servers: { ...config.servers, lease: server(lease) },
    databases: {
      ...config.databases,
      [LEASE_DATABASE_NAME]: {
        server: 'lease',
        database: decodeURIComponent(lease.pathname.slice(1)),
      },
    },
  }
}

/**
 * The database a deploy's evaluation records its sandbox lease in (`FACTORY_LEASE_DATABASE_URL`): the one the
 * supervisor of the running service reads, while the cases read a copy. Unset, leases go where everything goes.
 */
export const LEASE_DATABASE_NAME = 'lease'

/** The URL of the lease database, or undefined when leases stay in the main one. */
export function readLeaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.FACTORY_LEASE_DATABASE_URL || undefined
}

/**
 * The `storage` block for `loopzero.config.ts`. A missing `DATABASE_URL` yields no block, so a build
 * that never touches the database still works and readiness reports the gap; a URL that is set
 * but malformed fails here, at startup.
 */
export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): StorageConfig | undefined {
  if (!env.DATABASE_URL) return undefined
  return storageFromUrl(readDatabaseUrl(env))
}

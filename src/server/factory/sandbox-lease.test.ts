import { describe, expect, it } from 'vitest'

import { getLeaseDb } from '../db'
import { storageFromUrl } from '../db/config'
import type { Database } from '../db'
import { sandboxLease } from '../db/schema'

import { beat, identityOf } from './sandbox-lease'
import { reapable } from './sandbox-reaper'
import { readReaperFacts } from './sandbox-reaper-facts'

/** A database that keeps the rows inserted into `sandbox_lease` and answers a select of them. */
function fakeDb() {
  const rows: {
    id: string
    host: string
    pid: number
    started: string | null
    beatAt: Date
    staleSeenAt: Date | null
  }[] = []
  const db = {
    insert: (table: unknown) => ({
      values: (v: (typeof rows)[number]) => ({
        onConflictDoUpdate: async () => {
          if (table === sandboxLease) rows.push({ ...v, staleSeenAt: null })
        },
      }),
    }),
    select: () => ({
      from: (table: unknown) => ({ where: async () => (table === sandboxLease ? rows : []) }),
    }),
  } as unknown as Database
  return { db, rows }
}

describe('the lease database of a deploy evaluation', () => {
  const deploy = { FACTORY_LEASE_DATABASE_URL: 'postgres://u:p@h:5432/factory' }

  it('names a lease database next to the main one only when a URL is given', () => {
    const copy = 'postgres://u:p@h:5432/factory_eval_ab'
    expect(storageFromUrl(copy).databases).not.toHaveProperty('lease')
    expect(storageFromUrl(copy, deploy.FACTORY_LEASE_DATABASE_URL).databases).toMatchObject({
      main: { database: 'factory_eval_ab' },
      lease: { database: 'factory' },
    })
  })

  it('records the lease in the service database, not the copy, and the reaper keeps the sandbox', async () => {
    const service = fakeDb()
    const copy = fakeDb()
    const identity = identityOf(process.pid, 'eval-lease')
    await beat(
      getLeaseDb(
        deploy,
        () => copy.db,
        () => service.db,
      ),
      identity,
    )

    expect(service.rows.map((r) => r.id)).toEqual(['eval-lease'])
    expect(copy.rows).toEqual([])

    const listing = [
      {
        id: 'sbx',
        startedAt: new Date(),
        metadata: { app: 'aifactory', owner: 'eval', lease: 'eval-lease', host: 'h' },
      },
    ]
    const facts = await readReaperFacts(service.db, listing)
    expect(reapable(listing, facts).kill).toEqual([])
    // Read from the copy, as before the fix, the same sandbox is killed.
    const wrong = await readReaperFacts(copy.db, listing)
    expect(reapable(listing, wrong).kill).toHaveLength(1)
  })

  it('uses the main database when no lease URL is set', async () => {
    const main = fakeDb()
    const lease = fakeDb()
    await beat(
      getLeaseDb(
        {},
        () => main.db,
        () => lease.db,
      ),
      identityOf(process.pid, 'plain'),
    )
    expect(main.rows).toHaveLength(1)
    expect(lease.rows).toEqual([])
  })
})

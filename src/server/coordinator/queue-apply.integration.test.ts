import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { ingress, task } from '../db/schema'

import { moveAhead } from './queue-apply'

// The queue table the TheoKit worker creates on its first start.
const JOBS = `create table if not exists theokit_jobs (
  id text primary key, name text not null, input jsonb not null, attempts integer not null default 0,
  max_attempts integer not null default 1, available_at timestamptz not null default now(),
  locked_until timestamptz, traceparent text, idempotency_key text, created_at timestamptz not null default now(),
  lease_token text, last_error text, failed_at timestamptz)`

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
  await getPool().query(JOBS)
})
beforeEach(async () => {
  await getPool().query(JOBS)
  await getPool().query(
    'truncate table stage_event, task, ingress, theokit_jobs restart identity cascade',
  )
})
afterAll(() => getStorageManager().dispose())

let seeded = 0
async function seed(repo: string, minutes: number, lockedUntilMinutes?: number): Promise<number> {
  const db = getDb()
  const [i] = await db
    .insert(ingress)
    .values({
      deliveryId: `q-${++seeded}`,
      event: 'issues',
      payload: {},
      outcome: 'task_created',
      code: 'issue_labeled',
      reason: 'r',
    })
    .returning({ id: ingress.id })
  const [t] = await db
    .insert(task)
    .values({ ingressId: i.id, repository: repo, issueNumber: seeded, issueTitle: 'T' })
    .returning({ id: task.id })
  await getPool().query(
    `insert into theokit_jobs (id, name, input, available_at, locked_until)
     values ($1, 'run-task', $2, now() + ($3 || ' minutes')::interval,
             case when $4::int is null then null else now() + ($4 || ' minutes')::interval end)`,
    [`job-${t.id}`, JSON.stringify({ taskId: t.id }), String(minutes), lockedUntilMinutes ?? null],
  )
  return t.id
}

const order = async () =>
  (await getPool().query('select id from theokit_jobs order by available_at, id')).rows.map(
    (r: { id: string }) => r.id,
  )

describe('moving a job ahead of the queue', () => {
  it('puts it before the pending jobs of its repository only', async () => {
    const a = await seed('o/sdk', 1)
    const b = await seed('o/sdk', 2)
    const fix = await seed('o/sdk', 3)
    const other = await seed('o/other', -10)
    expect(await moveAhead(getDb(), fix, 'o/sdk')).toBe(true)
    expect(await order()).toEqual([`job-${other}`, `job-${fix}`, `job-${a}`, `job-${b}`])
  })

  it('leaves a job a worker holds where it is', async () => {
    const held = await seed('o/sdk', 1, 30)
    const fix = await seed('o/sdk', 2)
    await moveAhead(getDb(), fix, 'o/sdk')
    expect(await order()).toEqual([`job-${held}`, `job-${fix}`])
  })

  it('moves nothing for a job that is not pending', async () => {
    const held = await seed('o/sdk', 1, 30)
    expect(await moveAhead(getDb(), held, 'o/sdk')).toBe(false)
  })
})

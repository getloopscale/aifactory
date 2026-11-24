import { count, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { storageFromUrl } from '../db/config'
import { getDb, getPool, readDatabaseUrl } from '../db'
import { ingress, task } from '../db/schema'
import type { LinearFacts } from '../linear/ingress'

import { recordLinearDelivery } from './linear-record'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})

beforeEach(async () => {
  await getPool().query(
    'truncate table stage_event, task, ingress, repository, theokit_jobs restart identity cascade',
  )
  await getPool().query(
    "insert into repository (full_name, enabled, linear_team_id) values ('paulo/app', true, 'team-1'), ('paulo/off', false, 'team-2')",
  )
})

afterAll(() => getStorageManager().dispose())

const payload = (teamId: string, id = 'item-1') => ({
  type: 'Issue',
  action: 'create',
  url: 'https://linear.app/x/issue/ENG-1',
  data: { id, identifier: 'ENG-1', title: 'Fix it', teamId, labels: [{ name: 'factory' }] },
})
const nothingToRead = async (): Promise<LinearFacts> => {
  throw new Error('the payload is complete: nothing to read')
}

describe('recordLinearDelivery', () => {
  it('creates one task for a labelled item of a mapped, enabled team, and none for a redelivery', async () => {
    const first = await recordLinearDelivery(
      getDb(),
      { deliveryId: 'linear:d1', payload: payload('team-1') },
      nothingToRead,
    )
    expect(first.status).toBe('task_created')
    const again = await recordLinearDelivery(
      getDb(),
      { deliveryId: 'linear:d1', payload: payload('team-1') },
      nothingToRead,
    )
    expect(again.status).toBe('duplicate')
    // Another delivery of the same item is recorded and points at the task that exists.
    const other = await recordLinearDelivery(
      getDb(),
      { deliveryId: 'linear:d2', payload: payload('team-1') },
      nothingToRead,
    )
    expect(other.status).toBe('task_exists')
    const [{ n }] = await getDb().select({ n: count() }).from(task)
    expect(n).toBe(1)
    const [row] = await getDb().select().from(task)
    expect(row).toMatchObject({
      source: 'linear',
      externalId: 'item-1',
      displayIdentifier: 'ENG-1',
      repository: 'paulo/app',
    })
    expect(row.issueNumber).toBeLessThan(0)
  })

  it('records repository_disabled for a team mapped to a disabled repository and creates no task', async () => {
    const result = await recordLinearDelivery(
      getDb(),
      { deliveryId: 'linear:d3', payload: payload('team-2') },
      nothingToRead,
    )
    expect(result).toMatchObject({ status: 'ignored', code: 'repository_disabled' })
    const [row] = await getDb().select().from(ingress).where(eq(ingress.deliveryId, 'linear:d3'))
    expect(row.code).toBe('repository_disabled')
    const [{ n }] = await getDb().select({ n: count() }).from(task)
    expect(n).toBe(0)
  })

  it('reads what the payload omits, and records nothing when the read fails', async () => {
    const sparse = { type: 'Issue', action: 'update', data: { id: 'item-9' } }
    const read = vi.fn(async () => ({
      itemId: 'item-9',
      identifier: 'ENG-9',
      url: 'https://linear.app/x/issue/ENG-9',
      title: 'Nine',
      teamId: 'team-1',
      labels: ['factory'],
      closed: false,
    }))
    const ok = await recordLinearDelivery(
      getDb(),
      { deliveryId: 'linear:d4', payload: sparse },
      read,
    )
    expect(ok.status).toBe('task_created')
    await expect(
      recordLinearDelivery(
        getDb(),
        { deliveryId: 'linear:d5', payload: { ...sparse, data: { id: 'item-10' } } },
        async () => {
          throw new Error('Linear answered 500')
        },
      ),
    ).rejects.toThrow('500')
    const [{ n }] = await getDb()
      .select({ n: count() })
      .from(ingress)
      .where(eq(ingress.deliveryId, 'linear:d5'))
    expect(n).toBe(0)
  })

  it('cancels the task of an item that closed or lost its label, and ignores a closed item that never had one', async () => {
    const started = await recordLinearDelivery(
      getDb(),
      { deliveryId: 'linear:w1', payload: payload('team-1') },
      nothingToRead,
    )
    expect(started.status).toBe('task_created')
    const closed = {
      ...payload('team-1'),
      action: 'update',
      data: { ...payload('team-1').data, state: { type: 'completed' } },
    }
    const result = await recordLinearDelivery(
      getDb(),
      { deliveryId: 'linear:w2', payload: closed },
      nothingToRead,
    )
    expect(result).toMatchObject({ status: 'routed', code: 'issue_closed' })
    const [row] = await getDb().select().from(task)
    expect(row.stage).toBe('cancelled')
    const never = await recordLinearDelivery(
      getDb(),
      {
        deliveryId: 'linear:w3',
        payload: { ...closed, data: { ...closed.data, id: 'item-2' } },
      },
      nothingToRead,
    )
    expect(never).toMatchObject({ status: 'ignored', code: 'item_closed' })
  })

  it('starts a cancelled task over when the item is labelled again, and routes a withdrawal under its own code', async () => {
    await recordLinearDelivery(
      getDb(),
      { deliveryId: 'linear:r1', payload: payload('team-1') },
      nothingToRead,
    )
    const unlabeled = {
      ...payload('team-1'),
      action: 'update',
      data: { ...payload('team-1').data, labels: [] },
    }
    await recordLinearDelivery(
      getDb(),
      { deliveryId: 'linear:r2', payload: unlabeled },
      nothingToRead,
    )
    const [withdrawn] = await getDb()
      .select()
      .from(ingress)
      .where(eq(ingress.deliveryId, 'linear:r2'))
    expect(withdrawn).toMatchObject({ outcome: 'routed', code: 'issue_unlabeled' })
    const queued: [number, string | undefined][] = []
    const again = await recordLinearDelivery(
      getDb(),
      { deliveryId: 'linear:r3', payload: payload('team-1') },
      nothingToRead,
      async (taskId, restartedBy) => void queued.push([taskId, restartedBy]),
    )
    expect(again.status).toBe('task_restarted')
    expect(queued).toEqual([[expect.any(Number), 'linear:r3']])
  })
})

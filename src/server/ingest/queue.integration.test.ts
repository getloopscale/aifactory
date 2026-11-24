import { and, count, desc, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { PostgresJobBackend, createOutbox, createQueueClient } from 'theokit/server/jobs'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createPool, getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { ingress, stageEvent, task } from '../db/schema'

import { recordAndQueue } from './queue'
import type { Delivery } from './record'

const backend = PostgresJobBackend.fromStorageManager(getStorageManager(), 'main', createPool)
const queue = createQueueClient(backend, createOutbox())

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
  await backend.migrate()
})
beforeEach(async () => {
  await getPool().query(
    'truncate table stage_event, task, ingress, theokit_jobs, repository restart identity cascade',
  )
  await getPool().query("insert into repository (full_name, enabled) values ('paulo/app', true)")
})
afterAll(() => getStorageManager().dispose())

const labeled = (number = 7, label = 'factory'): unknown => ({
  action: 'labeled',
  label: { name: label },
  issue: { number, title: 'Fix it', labels: [{ name: label }] },
  repository: { full_name: 'paulo/app' },
})
const delivery = (id: string, payload: unknown = labeled(), event = 'issues'): Delivery => ({
  deliveryId: id,
  event,
  payload,
})

const jobs = async () =>
  (await getPool().query<{ name: string; input: unknown }>('select name, input from theokit_jobs'))
    .rows

describe('a delivery and its job', () => {
  it('queues exactly one run-task job for the task it created', async () => {
    const result = await recordAndQueue(delivery('d-1'), queue)

    expect(result.status).toBe('task_created')
    const [{ id }] = await getDb().select().from(task)
    expect(await jobs()).toEqual([{ name: 'run-task', input: { taskId: id } }])
  })

  it('queues nothing for a redelivery', async () => {
    await recordAndQueue(delivery('d-1'), queue)
    const again = await recordAndQueue(delivery('d-1'), queue)

    expect(again).toEqual({ status: 'duplicate' })
    expect(await jobs()).toHaveLength(1)
  })

  it('queues nothing when the issue already has a task', async () => {
    await recordAndQueue(delivery('d-1'), queue)
    const again = await recordAndQueue(delivery('d-2'), queue)

    expect(again.status).toBe('task_exists')
    expect(await jobs()).toHaveLength(1)
  })

  it('queues nothing for a delivery that is ignored', async () => {
    const result = await recordAndQueue(delivery('d-1', labeled(7, 'bug')), queue)

    expect(result.status).toBe('ignored')
    expect(await jobs()).toHaveLength(0)
  })

  it('queues nothing for a delivery that is routed', async () => {
    const closed = { ...(labeled() as object), action: 'closed', sender: { login: 'alice' } }
    const result = await recordAndQueue(delivery('d-1', closed), queue)

    expect(result.status).toBe('routed')
    expect(await jobs()).toHaveLength(0)
  })

  it('rolls the delivery and the task back when the job cannot be queued', async () => {
    const broken = {
      ...queue,
      enqueueInTransaction: async () => {
        throw new Error('queue is down')
      },
    } as unknown as typeof queue

    await expect(recordAndQueue(delivery('d-1'), broken)).rejects.toThrow('queue is down')

    const db = getDb()
    expect((await db.select({ n: count() }).from(ingress))[0].n).toBe(0)
    expect((await db.select({ n: count() }).from(task))[0].n).toBe(0)
    expect(await jobs()).toHaveLength(0)
  })

  it('lets the same delivery succeed once the queue is back', async () => {
    const broken = {
      ...queue,
      enqueueInTransaction: async () => {
        throw new Error('queue is down')
      },
    } as unknown as typeof queue
    await recordAndQueue(delivery('d-1'), broken).catch(() => {})

    const result = await recordAndQueue(delivery('d-1'), queue)

    expect(result.status).toBe('task_created')
    expect(await jobs()).toHaveLength(1)
  })
})

describe('an issue that no longer asks for the work', () => {
  const changed = (action: string, extra: object = {}): unknown => ({
    ...(labeled() as object),
    action,
    sender: { login: 'alice' },
    ...extra,
  })
  const closed = () => changed('closed')
  const unlabeled = () => changed('unlabeled', { label: { name: 'factory' } })

  /** A task for issue 7 in `stage`, with a `run-task` job queued for it that no worker took. */
  async function taskIn(stage: string): Promise<number> {
    await recordAndQueue(delivery('take'), queue)
    const [{ id }] = await getDb().select().from(task)
    await getPool().query('update task set stage = $1 where id = $2', [stage, id])
    return id
  }

  const stageOf = async (id: number) =>
    (await getDb().select().from(task).where(eq(task.id, id)))[0].stage
  const lastEvent = async (id: number) =>
    (
      await getDb()
        .select()
        .from(stageEvent)
        .where(eq(stageEvent.taskId, id))
        .orderBy(desc(stageEvent.id))
        .limit(1)
    )[0]

  it('cancels a queued task when its issue is closed, and deletes its queued run', async () => {
    const id = await taskIn('intake')

    const result = await recordAndQueue(delivery('close', closed()), queue)

    expect(result).toMatchObject({ status: 'routed', code: 'issue_closed' })
    expect(await stageOf(id)).toBe('cancelled')
    expect(await lastEvent(id)).toMatchObject({
      stage: 'cancelled',
      detail: { reason: 'the issue was closed', by: 'alice' },
    })
    expect(await jobs()).toEqual([])
  })

  it('cancels a failed task, so it does not run again on its own', async () => {
    const id = await taskIn('failed')

    await recordAndQueue(delivery('close', closed()), queue)

    expect(await stageOf(id)).toBe('cancelled')
    expect(await jobs()).toEqual([])
  })

  it('cancels a queued task when the factory label is removed', async () => {
    const id = await taskIn('intake')

    const result = await recordAndQueue(delivery('unlabel', unlabeled()), queue)

    expect(result).toMatchObject({ status: 'routed', code: 'issue_unlabeled' })
    expect(await stageOf(id)).toBe('cancelled')
    expect(await lastEvent(id)).toMatchObject({
      stage: 'cancelled',
      detail: { reason: 'the factory label was removed', by: 'alice' },
    })
    expect(await jobs()).toEqual([])
  })

  it('deletes the merge-task job of approved work waiting in merge', async () => {
    const id = await taskIn('merge')
    await getPool().query(`delete from theokit_jobs`)
    await queue.enqueue('merge-task', { taskId: id, sha: 'abc1234' })

    await recordAndQueue(delivery('close', closed()), queue)

    expect(await stageOf(id)).toBe('cancelled')
    expect(await jobs()).toEqual([])
  })

  it('deletes the resume-task job of a waiting task whose answer was taken', async () => {
    const id = await taskIn('waiting')
    await getPool().query(`delete from theokit_jobs`)
    await queue.enqueue('resume-task', { taskId: id, questionId: 1 })

    await recordAndQueue(delivery('close', closed()), queue)

    expect(await stageOf(id)).toBe('cancelled')
    expect(await jobs()).toEqual([])
  })

  it('cancels a task whose run a worker holds, and leaves the held job alone', async () => {
    const id = await taskIn('build')
    await getPool().query(`update theokit_jobs set locked_until = now() + interval '2 minutes'`)

    await recordAndQueue(delivery('close', closed()), queue)

    expect(await stageOf(id)).toBe('cancelled')
    expect(await jobs()).toEqual([{ name: 'run-task', input: { taskId: id } }])
  })

  it('leaves alone a job whose lease ran out, since its run may still be going on', async () => {
    const id = await taskIn('build')
    await getPool().query(
      `update theokit_jobs set locked_until = now() - interval '1 minute', attempts = 1`,
    )

    await recordAndQueue(delivery('close', closed()), queue)

    expect(await stageOf(id)).toBe('cancelled')
    expect(await jobs()).toEqual([{ name: 'run-task', input: { taskId: id } }])
  })

  it.each(['done', 'handoff'])('leaves a task in %s and its jobs untouched', async (stage) => {
    const id = await taskIn(stage)
    const before = await lastEvent(id)

    await recordAndQueue(delivery('close', closed()), queue)
    await recordAndQueue(delivery('unlabel', unlabeled()), queue)

    expect(await stageOf(id)).toBe(stage)
    expect(await lastEvent(id)).toEqual(before)
    expect(await jobs()).toEqual([{ name: 'run-task', input: { taskId: id } }])
  })

  it('leaves the task of another issue alone', async () => {
    const id = await taskIn('intake')

    await recordAndQueue(
      delivery('close', changed('closed', { issue: { number: 8, title: 'Other', labels: [] } })),
      queue,
    )

    expect(await stageOf(id)).toBe('intake')
    expect(await jobs()).toHaveLength(1)
  })

  it('brings nothing back when the issue is reopened after it was cancelled', async () => {
    const id = await taskIn('intake')
    await recordAndQueue(delivery('close', closed()), queue)

    const result = await recordAndQueue(delivery('reopen', changed('reopened')), queue)

    expect(result).toMatchObject({ status: 'routed', code: 'issue_reopened' })
    expect(await stageOf(id)).toBe('cancelled')
    expect(await jobs()).toEqual([])
  })

  it('cancels nothing twice when the same close is delivered again', async () => {
    const id = await taskIn('intake')
    await recordAndQueue(delivery('close', closed()), queue)
    await recordAndQueue(delivery('close-2', closed()), queue)

    const cancelled = await getDb()
      .select()
      .from(stageEvent)
      .where(and(eq(stageEvent.taskId, id), eq(stageEvent.stage, 'cancelled')))
    expect(cancelled).toHaveLength(1)
  })

  it('starts a cancelled task over when the factory label is added again, and queues its run', async () => {
    const id = await taskIn('intake')
    await recordAndQueue(delivery('unlabel', unlabeled()), queue)

    const result = await recordAndQueue(delivery('relabel', changed('labeled')), queue)

    expect(result).toEqual({ status: 'task_restarted', taskId: id })
    expect(await stageOf(id)).toBe('intake')
    expect(await lastEvent(id)).toMatchObject({
      stage: 'intake',
      detail: { reason: 'the factory label was added again', by: 'alice' },
    })
    expect(await jobs()).toEqual([{ name: 'run-task', input: { taskId: id } }])
  })

  it('starts a failed task over when the factory label is added again, even with its failed job on file', async () => {
    const id = await taskIn('failed')
    await getPool().query(`update theokit_jobs set failed_at = now(), attempts = 1`)

    const result = await recordAndQueue(delivery('relabel', changed('labeled')), queue)

    expect(result).toEqual({ status: 'task_restarted', taskId: id })
    expect(await stageOf(id)).toBe('intake')
    const pending = await getPool().query('select input from theokit_jobs where failed_at is null')
    expect(pending.rows).toEqual([{ input: { taskId: id } }])
  })

  it('starts a task over once when the same label delivery arrives twice', async () => {
    await taskIn('intake')
    await recordAndQueue(delivery('unlabel', unlabeled()), queue)
    await recordAndQueue(delivery('relabel', changed('labeled')), queue)

    const again = await recordAndQueue(delivery('relabel', changed('labeled')), queue)

    expect(again).toEqual({ status: 'duplicate' })
    expect(await jobs()).toHaveLength(1)
  })

  describe('a pull request the factory did not open', () => {
    const pull = (sha: string, over: { assoc?: string; ref?: string } = {}) => ({
      action: 'opened',
      pull_request: {
        number: 12,
        draft: false,
        user: { login: 'carol' },
        author_association: over.assoc ?? 'COLLABORATOR',
        labels: [],
        head: { sha, ref: over.ref ?? 'patch-1', repo: { full_name: 'carol/app' } },
      },
      repository: { full_name: 'paulo/app' },
    })
    const review = (id: string, payload: unknown) =>
      recordAndQueue(delivery(id, payload, 'pull_request'), queue)
    const reviewJobs = async () => (await jobs()).filter((j) => j.name === 'review-pull-request')

    it('queues nothing while the repository has the setting off', async () => {
      await review('p-1', pull('a'.repeat(40)))
      expect(await reviewJobs()).toEqual([])
    })

    describe('with the setting on', () => {
      beforeEach(async () => {
        await getPool().query('update repository set review_external_pulls = true')
      })

      it('queues one review per head, and none for a redelivery or a repeated head', async () => {
        await review('p-1', pull('a'.repeat(40)))
        await review('p-1', pull('a'.repeat(40)))
        await review('p-2', pull('a'.repeat(40)))
        expect(await reviewJobs()).toHaveLength(1)
        await review('p-3', { ...pull('b'.repeat(40)), action: 'synchronize' })
        expect(await reviewJobs()).toHaveLength(2)
      })

      it('queues nothing for a stranger, nor for a factory branch', async () => {
        await review('p-1', pull('a'.repeat(40), { assoc: 'NONE' }))
        await review('p-2', pull('c'.repeat(40), { ref: 'factory/467' }))
        expect(await reviewJobs()).toEqual([])
      })
    })
  })
})

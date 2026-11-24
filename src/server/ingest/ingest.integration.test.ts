import { createHmac } from 'node:crypto'

import { count, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { PostgresJobBackend, createOutbox, createQueueClient } from 'theokit/server/jobs'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { storageFromUrl } from '../db/config'
import { createPool, getDb, getPool, readDatabaseUrl } from '../db'
import { decision, ingress, stageEvent, task } from '../db/schema'
import { openFollowUpIssue, type FollowUpRequest } from '../panel/actions'

import { recordAndQueue } from './queue'
import { recordDelivery, type Delivery } from './record'
import { handleGithubDelivery } from './webhook'

const SECRET = 'test-secret'

const backend = PostgresJobBackend.fromStorageManager(getStorageManager(), 'main', createPool)
const queue = createQueueClient(backend, createOutbox())

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
  await backend.migrate()
})

beforeEach(async () => {
  await getPool().query(
    'truncate table stage_event, task, ingress, repository, theokit_jobs, failure_signature restart identity cascade',
  )
  await getPool().query("insert into repository (full_name, enabled) values ('paulo/app', true)")
})

afterAll(() => getStorageManager().dispose())

function labeledIssue(number = 7, label = 'factory') {
  return {
    action: 'labeled',
    label: { name: label },
    issue: { number, title: 'Fix the login redirect', labels: [{ name: label }] },
    repository: { full_name: 'paulo/app' },
  }
}

function delivery(
  payload: unknown,
  { id = 'delivery-1', event = 'issues', secret = SECRET } = {},
): Request {
  const body = JSON.stringify(payload)
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  return new Request('http://localhost/api/webhooks/github', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': id,
      'x-github-event': event,
      'x-hub-signature-256': signature,
    },
    body,
  })
}

const deps = { secret: SECRET, record: (d: Delivery) => recordDelivery(getDb(), d) }

async function rows() {
  const db = getDb()
  const [{ value: deliveries }] = await db.select({ value: count() }).from(ingress)
  const [{ value: tasks }] = await db.select({ value: count() }).from(task)
  return { deliveries, tasks }
}

describe('GitHub deliveries', () => {
  it('turns an issue labeled factory into exactly one task in intake', async () => {
    const response = await handleGithubDelivery(delivery(labeledIssue()), deps)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'task_created' })
    expect(await rows()).toEqual({ deliveries: 1, tasks: 1 })
    const [created] = await getDb().select().from(task)
    const events = await getDb().select().from(stageEvent)
    expect(events.map((e) => [e.taskId, e.stage])).toEqual([[created.id, 'intake']])
    expect(created).toMatchObject({
      repository: 'paulo/app',
      issueNumber: 7,
      issueTitle: 'Fix the login redirect',
      stage: 'intake',
    })
  })

  it('does not duplicate when the same delivery arrives again', async () => {
    await handleGithubDelivery(delivery(labeledIssue()), deps)
    const again = await handleGithubDelivery(delivery(labeledIssue()), deps)

    expect(await again.json()).toEqual({ status: 'duplicate' })
    expect(await rows()).toEqual({ deliveries: 1, tasks: 1 })
  })

  it('keeps one task when the label is removed and added again in a new delivery', async () => {
    const first = await handleGithubDelivery(delivery(labeledIssue(), { id: 'd-1' }), deps)
    const second = await handleGithubDelivery(delivery(labeledIssue(), { id: 'd-2' }), deps)

    const firstTask = (await first.json()) as { taskId: number }
    expect(await second.json()).toEqual({ status: 'task_exists', taskId: firstTask.taskId })
    expect(await rows()).toEqual({ deliveries: 2, tasks: 1 })
    const [redelivered] = await getDb().select().from(ingress).where(eq(ingress.deliveryId, 'd-2'))
    expect(redelivered.outcome).toBe('task_exists')
  })

  it('records an ignored delivery with its code and reason, and creates no task', async () => {
    const response = await handleGithubDelivery(delivery(labeledIssue(7, 'bug')), deps)

    expect(await response.json()).toMatchObject({ status: 'ignored', code: 'label_not_factory' })
    expect(await rows()).toEqual({ deliveries: 1, tasks: 0 })
    const [row] = await getDb().select().from(ingress)
    expect(row).toMatchObject({
      outcome: 'ignored',
      code: 'label_not_factory',
      reason: 'label "bug" is not "factory"',
      repository: 'paulo/app',
    })
  })

  it('rejects a bad signature with 401 and writes nothing', async () => {
    const response = await handleGithubDelivery(
      delivery(labeledIssue(), { secret: 'wrong-secret' }),
      deps,
    )

    expect(response.status).toBe(401)
    expect(await rows()).toEqual({ deliveries: 0, tasks: 0 })
  })

  it('rejects a body altered after signing', async () => {
    const signed = delivery(labeledIssue(7))
    const tampered = new Request(signed.url, {
      method: 'POST',
      headers: signed.headers,
      body: JSON.stringify(labeledIssue(8)),
    })

    expect((await handleGithubDelivery(tampered, deps)).status).toBe(401)
    expect(await rows()).toEqual({ deliveries: 0, tasks: 0 })
  })

  it('answers 503 and writes nothing when no secret is configured', async () => {
    const response = await handleGithubDelivery(delivery(labeledIssue()), {
      secret: undefined,
      record: deps.record,
    })

    expect(response.status).toBe(503)
    expect(await rows()).toEqual({ deliveries: 0, tasks: 0 })
  })

  it('answers 400 when the delivery headers are missing', async () => {
    const signed = delivery(labeledIssue())
    const headers = new Headers(signed.headers)
    headers.delete('x-github-delivery')
    const request = new Request(signed.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(labeledIssue()),
    })

    expect((await handleGithubDelivery(request, deps)).status).toBe(400)
    expect(await rows()).toEqual({ deliveries: 0, tasks: 0 })
  })

  it('creates one task when the same delivery arrives twice at once', async () => {
    const results = await Promise.all([
      handleGithubDelivery(delivery(labeledIssue()), deps),
      handleGithubDelivery(delivery(labeledIssue()), deps),
    ])

    const statuses = (await Promise.all(results.map((r) => r.json()))) as { status: string }[]
    expect(statuses.map((s) => s.status).sort()).toEqual(['duplicate', 'task_created'])
    expect(await rows()).toEqual({ deliveries: 1, tasks: 1 })
  })
})

describe('deliveries that are routed', () => {
  const comment = {
    action: 'created',
    issue: { number: 7 },
    comment: { id: 9001, user: { login: 'alice' }, author_association: 'MEMBER' },
    repository: { full_name: 'paulo/app' },
  }

  it('stores a signed issue_comment as routed, with its own code, and creates no task', async () => {
    const response = await handleGithubDelivery(delivery(comment, { event: 'issue_comment' }), deps)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: 'routed',
      code: 'issue_comment_created',
      intent: { kind: 'issue_comment_created', issueNumber: 7, commentId: 9001 },
    })
    expect(await rows()).toEqual({ deliveries: 1, tasks: 0 })
    const [row] = await getDb().select().from(ingress)
    expect(row).toMatchObject({
      event: 'issue_comment',
      outcome: 'routed',
      code: 'issue_comment_created',
      repository: 'paulo/app',
    })
  })

  it('stores a payload that does not match its schema as payload_invalid', async () => {
    const response = await handleGithubDelivery(
      delivery({ ...comment, comment: { id: 'not-a-number' } }, { event: 'issue_comment' }),
      deps,
    )

    expect(await response.json()).toMatchObject({ status: 'ignored', code: 'payload_invalid' })
    const [row] = await getDb().select().from(ingress)
    expect(row).toMatchObject({ outcome: 'ignored', code: 'payload_invalid' })
    expect(await rows()).toEqual({ deliveries: 1, tasks: 0 })
  })

  it('keeps the code of an event the factory does not read', async () => {
    const response = await handleGithubDelivery(
      delivery({ repository: { full_name: 'paulo/app' } }, { event: 'push' }),
      deps,
    )

    expect(await response.json()).toMatchObject({ status: 'ignored', code: 'event_not_issues' })
    const [row] = await getDb().select().from(ingress)
    expect(row).toMatchObject({ outcome: 'ignored', code: 'event_not_issues' })
  })

  it('routes a delivery in a repository that is not enabled, since it starts nothing', async () => {
    const elsewhere = { ...comment, repository: { full_name: 'paulo/other' } }
    await handleGithubDelivery(delivery(elsewhere, { event: 'issue_comment' }), deps)

    const [row] = await getDb().select().from(ingress)
    expect(row).toMatchObject({ outcome: 'routed', repository: 'paulo/other' })
    expect(await rows()).toEqual({ deliveries: 1, tasks: 0 })
  })
})

describe('which repositories may start work', () => {
  const take = (repo: string, id: string) =>
    recordDelivery(getDb(), {
      deliveryId: id,
      event: 'issues',
      payload: {
        action: 'labeled',
        label: { name: 'factory' },
        issue: { number: 3, title: 'T', labels: [{ name: 'factory' }] },
        repository: { full_name: repo },
      },
    })

  it('ignores an issue in a repository that was never enabled, and says why', async () => {
    const result = await take('paulo/other', 'x-1')
    expect(result).toMatchObject({ status: 'ignored', code: 'repository_disabled' })
    expect((result as { reason: string }).reason).toContain('paulo/other is not enabled')
    expect(await getDb().select().from(task)).toEqual([])
  })

  it('ignores one in a repository that was enabled and then switched off', async () => {
    await getPool().query("update repository set enabled = false where full_name = 'paulo/app'")
    expect(await take('paulo/app', 'x-2')).toMatchObject({
      status: 'ignored',
      code: 'repository_disabled',
    })
  })

  it('takes one in an enabled repository whatever the case GitHub writes the name in', async () => {
    expect(await take('Paulo/App', 'x-3')).toMatchObject({ status: 'task_created' })
  })

  it('records the ignored delivery, so the refusal can be found later', async () => {
    await take('paulo/other', 'x-4')
    const [row] = await getDb().select().from(ingress).where(eq(ingress.deliveryId, 'x-4'))
    expect(row).toMatchObject({ outcome: 'ignored', code: 'repository_disabled' })
  })
})

describe('what is written on the factory pull request', () => {
  const written = (
    over: { user?: object; association?: string; body?: string; id?: number; state?: string } = {},
  ) => ({
    action: 'submitted',
    review: {
      id: over.id ?? 77,
      user: over.user ?? { login: 'alice', type: 'User' },
      author_association: over.association ?? 'OWNER',
      body: over.body ?? 'this misses the empty-input case',
      state: over.state ?? 'commented',
    },
    pull_request: { number: 12, head: { sha: 'abc' } },
    repository: { full_name: 'paulo/app' },
  })

  const followUps: FollowUpRequest[] = []
  const send = (
    payload: unknown,
    id: string,
    followUp = async (r: FollowUpRequest) => void followUps.push(r),
  ) =>
    handleGithubDelivery(delivery(payload, { id, event: 'pull_request_review' }), {
      secret: SECRET,
      record: (d: Delivery) => recordAndQueue(d, queue, followUp),
    })
  const jobs = async () =>
    (
      await getPool().query<{ name: string; input: Record<string, unknown> }>(
        'select name, input from theokit_jobs',
      )
    ).rows

  /** A task for issue 7 in `stage` with its pull request 12 and no job queued. */
  async function taskIn(stage: string, mergedSha: string | null = null): Promise<number> {
    await recordAndQueue({ deliveryId: 'take', event: 'issues', payload: labeledIssue() }, queue)
    const [{ id }] = await getDb().select().from(task)
    await getPool().query(
      'update task set stage = $1, merged_sha = $2, head_sha = $3, pull_request_url = $4 where id = $5',
      [stage, mergedSha, 'abc', 'https://github.com/paulo/app/pull/12', id],
    )
    await getPool().query('delete from theokit_jobs')
    followUps.length = 0
    return id
  }

  it('queues one run on the branch, with the review text, for an owner on an open pull request', async () => {
    const id = await taskIn('done')
    const response = await send(written(), 'r-1')

    expect(await response.json()).toMatchObject({
      status: 'routed',
      written: { done: 'sent_back' },
    })
    const [made] = await getDb().select().from(decision).where(eq(decision.taskId, id))
    expect(made).toMatchObject({ kind: 'request_changes' })
    expect(made.note).toContain('this misses the empty-input case')
    expect(await jobs()).toEqual([{ name: 'run-task', input: { taskId: id, decisionId: made.id } }])
    const [{ stage }] = await getDb().select().from(task).where(eq(task.id, id))
    expect(stage).toBe('intake')
    // A person's send-back, so it is not counted as an automatic run.
    const [intake] = (
      await getDb().select().from(stageEvent).where(eq(stageEvent.taskId, id))
    ).slice(-1)
    expect(intake.detail).not.toHaveProperty('automatic')
  })

  it('stores a review of an author the repository does not trust as routed and queues nothing', async () => {
    await taskIn('done')
    const response = await send(written({ association: 'NONE' }), 'r-1')

    expect(await response.json()).toMatchObject({ status: 'routed', written: { done: 'ignored' } })
    expect((await getDb().select().from(ingress)).at(-1)).toMatchObject({ outcome: 'routed' })
    expect(await jobs()).toEqual([])
  })

  it('queues nothing and files nothing once the owner disabled the repository', async () => {
    await taskIn('done')
    await getPool().query('update repository set enabled = false')
    await send(written(), 'r-1')
    await getPool().query("update task set merged_sha = 'm'")
    await send(written({ id: 78 }), 'r-2')

    expect(await jobs()).toEqual([])
    expect(followUps).toEqual([])
  })

  it('queues nothing and files nothing for an approving review with text', async () => {
    await taskIn('done')
    await send(written({ state: 'approved', body: 'LGTM, thanks' }), 'r-1')
    await getPool().query("update task set merged_sha = 'm'")
    await send(written({ state: 'approved', body: 'LGTM, thanks', id: 78 }), 'r-2')

    expect(await jobs()).toEqual([])
    expect(followUps).toEqual([])
  })

  it('queues nothing for a review written by the App bot', async () => {
    await taskIn('done')
    await send(
      written({ user: { login: 'factory[bot]', type: 'Bot' }, association: 'MEMBER' }),
      'r-1',
    )
    expect(await jobs()).toEqual([])
  })

  it('queues one run only, whatever the redelivery', async () => {
    await taskIn('done')
    await send(written(), 'r-1')
    expect(await (await send(written(), 'r-1')).json()).toEqual({ status: 'duplicate' })
    // The same review under another delivery id finds the task already sent back.
    await send(written(), 'r-2')
    expect(await jobs()).toHaveLength(1)
  })

  it('asks for a follow-up, and queues no run, when the work is already merged', async () => {
    const id = await taskIn('done', 'merged')
    await send(written(), 'r-1')

    expect(followUps).toMatchObject([{ taskId: id, issueNumber: 7, by: 'alice' }])
    expect(await jobs()).toEqual([])
  })

  it('rolls the delivery back when the follow-up cannot be filed, so it is delivered again', async () => {
    await taskIn('done', 'merged')
    const down = async () => {
      throw new Error('GitHub is down')
    }
    await expect(send(written(), 'r-1', down)).rejects.toThrow('GitHub is down')
    expect(await getDb().select().from(ingress).where(eq(ingress.deliveryId, 'r-1'))).toEqual([])

    await send(written(), 'r-1')
    expect(followUps).toHaveLength(1)
  })

  it('files one issue for a review delivered twice', async () => {
    await taskIn('done', 'merged')
    await send(written(), 'r-1')
    await send(written(), 'r-2')
    expect(followUps).toHaveLength(2)

    const created: number[] = []
    const api = {
      db: getDb(),
      github: { installationToken: async () => ({ token: 't' }) } as never,
      issues: {
        createIssue: async () => {
          created.push(created.length + 1)
          return { number: 40, url: 'u' }
        },
      },
    }
    await openFollowUpIssue(api, followUps[0])
    const again = await openFollowUpIssue(api, followUps[1])
    expect(created).toEqual([1])
    expect(again).toEqual({ already: 40 })
  })
})

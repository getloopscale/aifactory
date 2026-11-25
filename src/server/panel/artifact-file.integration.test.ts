import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { evidence, evidenceArtifact, ingress, task } from '../db/schema'
import { artifactsAt, storeEvidence } from '../factory/artifacts'
import type { CheckResult } from '../factory/evidence'
import { pruneRetained, TRANSCRIPT_RETENTION_DAYS } from '../factory/transcript-store'

import { serveArtifact } from './artifact-file'
import { taskDetail } from './queries'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query(
    'truncate table evidence_artifact, evidence, stage_event, task, ingress restart identity cascade',
  )
})
afterAll(() => getStorageManager().dispose())

let seeded = 0
async function seedTask(): Promise<number> {
  const db = getDb()
  const [i] = await db
    .insert(ingress)
    .values({
      deliveryId: `a-${++seeded}`,
      event: 'issues',
      payload: {},
      outcome: 'task_created',
      code: 'issue_labeled',
      reason: 'r',
    })
    .returning({ id: ingress.id })
  const [t] = await db
    .insert(task)
    .values({ ingressId: i.id, repository: 'paulo/app', issueNumber: seeded, issueTitle: 'x' })
    .returning({ id: task.id })
  return t.id
}

const result = (over: Partial<CheckResult> = {}): CheckResult => ({
  name: 'e2e',
  command: 'pnpm e2e',
  exitCode: 0,
  timedOut: false,
  passed: true,
  output: 'ok',
  durationMs: 10,
  ...over,
})
const file = (path: string, contentType: string, text = 'bytes') => ({
  path,
  contentType,
  content: Buffer.from(text),
})

describe('storeEvidence', () => {
  it('keeps the files and what was left out next to the evidence row of the commit', async () => {
    const id = await seedTask()
    await storeEvidence(
      getDb(),
      id,
      'sha1',
      result({
        artifacts: [file('screenshots/home.png', 'image/png')],
        omitted: ['trace.zip: over the limit'],
      }),
    )
    const [row] = await getDb().select().from(evidence)
    expect(row.omitted).toEqual(['trace.zip: over the limit'])
    const files = await artifactsAt(getDb(), id, 'sha1')
    expect(files.map((f) => f.path)).toEqual(['screenshots/home.png'])
    const [stored] = await getDb().select().from(evidenceArtifact)
    expect(stored).toMatchObject({ evidenceId: row.id, sha: 'sha1', sizeBytes: 5 })
  })
})

describe('serveArtifact', () => {
  it('offers page.html as a download, never as a page', async () => {
    const id = await seedTask()
    await storeEvidence(
      getDb(),
      id,
      's',
      result({ artifacts: [file('report/page.html', 'text/html', '<script>1</script>')] }),
    )
    const [{ id: artifactId }] = await artifactsAt(getDb(), id, 's')
    const response = await serveArtifact(getDb(), id, artifactId)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toMatch(/^attachment/)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('does not serve a file under the id of another task', async () => {
    const owner = await seedTask()
    const other = await seedTask()
    await storeEvidence(getDb(), owner, 's', result({ artifacts: [file('a.png', 'image/png')] }))
    const [{ id: artifactId }] = await artifactsAt(getDb(), owner, 's')
    expect((await serveArtifact(getDb(), other, artifactId)).status).toBe(404)
    expect((await serveArtifact(getDb(), owner, artifactId)).status).toBe(200)
  })
})

describe('the task detail', () => {
  it('lists the files of the latest verification only', async () => {
    const id = await seedTask()
    await storeEvidence(getDb(), id, 'old', result({ artifacts: [file('old.png', 'image/png')] }))
    await storeEvidence(getDb(), id, 'new', result({ artifacts: [file('new.png', 'image/png')] }))
    const detail = await taskDetail(getDb(), id)
    expect(detail?.evidence.map((e) => e.artifacts.map((a) => a.path))).toEqual([[], ['new.png']])
  })
})

describe('retention', () => {
  it('deletes files older than the retention and keeps newer ones', async () => {
    const id = await seedTask()
    await storeEvidence(
      getDb(),
      id,
      's',
      result({ artifacts: [file('old.png', 'image/png'), file('new.png', 'image/png')] }),
    )
    const now = new Date()
    const days = (n: number) => new Date(now.getTime() - n * 86_400_000)
    await getPool().query(`update evidence_artifact set at = $1 where path = 'old.png'`, [
      days(TRANSCRIPT_RETENTION_DAYS + 1),
    ])
    await pruneRetained(getDb(), now)
    expect((await artifactsAt(getDb(), id, 's')).map((f) => f.path)).toEqual(['new.png'])
  })
})

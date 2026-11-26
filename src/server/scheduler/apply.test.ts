import { describe, expect, it } from 'vitest'

import { applyAcceptance, type DraftDeps } from './apply'
import { ACCEPTANCE_HEADING, bodyHash } from './readiness'

const run = { taskId: 1, jobId: 'job-1', repository: 'o/r', issueNumber: 7 }
const CRITERIA = ['a test passes', 'the symbol exists', 'the output names it']

/** A database that answers what `applyAcceptance` asks, and keeps what it records. */
function fixture(over: {
  stage?: string
  queued?: boolean
  reads: { title: string; body: string }[]
}) {
  const recorded: { head: string; detail: unknown }[] = []
  const written: string[] = []
  const reads = [...over.reads]
  const db = {
    select: () => ({ from: () => ({ where: async () => [{ stage: over.stage ?? 'intake' }] }) }),
    execute: async () => ({ rowCount: over.queued === false ? 0 : 1 }),
    insert: () => ({
      values: (row: { head: string; detail: unknown }) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            recorded.push(row)
            return [{ id: 9 }]
          },
        }),
      }),
    }),
  }
  const deps = {
    db,
    github: { installationToken: async () => ({ token: 't', expiresAt: new Date() }) },
    issues: {
      updateIssueBody: async (_r: string, _t: string, _n: number, body: string) => {
        written.push(body)
      },
    },
    readIssue: async () => (reads.length > 1 ? reads.shift()! : reads[0]),
  } as unknown as DraftDeps
  return { deps, recorded, written }
}

describe('writing the drafted acceptance into the issue', () => {
  const judged = { title: 'T', body: 'Do it.' }

  it('appends the section once and records ready for the body GitHub holds afterwards', async () => {
    // GitHub stores the body with CRLF line endings.
    const stored = { title: 'T', body: `Do it.\r\n\r\n${ACCEPTANCE_HEADING}\r\n- x` }
    const f = fixture({ reads: [judged, stored] })
    expect(await applyAcceptance(f.deps, run, judged, CRITERIA)).toEqual({ drafted: true })
    expect(f.written).toHaveLength(1)
    expect(f.written[0]).toMatch(
      /^Do it\.\n\n## Acceptance \(drafted by the factory\)\n\n- a test passes\n/,
    )
    expect(f.recorded).toEqual([
      expect.objectContaining({
        head: bodyHash('T', stored.body),
        detail: expect.objectContaining({ verdict: 'ready' }),
      }),
    ])
  })

  it('writes nothing when the owner edited the issue after it was judged', async () => {
    const f = fixture({ reads: [{ title: 'T', body: 'Do it, differently.' }] })
    const done = await applyAcceptance(f.deps, run, judged, CRITERIA)
    expect(done).toMatchObject({ drafted: false, stale: true })
    expect(f.written).toEqual([])
    expect(f.recorded).toEqual([])
  })

  it('does not append a section the body already holds', async () => {
    const held = { title: 'T', body: `Do it.\n\n${ACCEPTANCE_HEADING}\n\n- x` }
    const f = fixture({ reads: [held] })
    expect(await applyAcceptance(f.deps, run, judged, CRITERIA)).toEqual({ drafted: true })
    expect(f.written).toEqual([])
    expect(f.recorded[0].head).toBe(bodyHash('T', held.body))
  })

  it('writes nothing for a task that left intake or whose run was taken', async () => {
    const left = fixture({ stage: 'cancelled', reads: [judged] })
    expect(await applyAcceptance(left.deps, run, judged, CRITERIA)).toMatchObject({
      drafted: false,
    })
    const taken = fixture({ queued: false, reads: [judged] })
    expect(await applyAcceptance(taken.deps, run, judged, CRITERIA)).toMatchObject({
      drafted: false,
    })
    expect([...left.written, ...taken.written]).toEqual([])
  })
})

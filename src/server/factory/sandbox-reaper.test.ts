import { describe, expect, it } from 'vitest'

import type { ListedSandbox } from './sandbox'
import { atWork, metadataFor, reapable, SANDBOX_GRACE_MS, type ReaperFacts } from './sandbox-reaper'

const NOW = new Date('2026-11-16T18:00:00Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms)
const sbx = (id: string, metadata: Record<string, string>, age = 60_000): ListedSandbox => ({
  id,
  startedAt: ago(age),
  metadata,
})
const facts = (over: Partial<ReaperFacts> = {}): ReaperFacts => ({
  now: NOW,
  graceMs: SANDBOX_GRACE_MS,
  host: 'here',
  tasks: new Map(),
  alive: () => true,
  ...over,
})
const task = (taskId: number, run: string) => metadataFor({ owner: 'task', taskId, run }, 'here', 1)

describe('metadataFor', () => {
  it('names the owner, the host and the process, as strings', () => {
    expect(metadataFor({ owner: 'task', taskId: 4, run: 'r' }, 'h', 9)).toEqual({
      owner: 'task',
      taskId: '4',
      run: 'r',
      host: 'h',
      pid: '9',
    })
    expect(metadataFor(undefined)).toEqual({})
  })
})

describe('reapable', () => {
  it('kills the sandbox of a finished task and one with no metadata past the grace, and keeps a running task', () => {
    const listing = [
      sbx('done', task(1, 'a')),
      sbx('running', task(2, 'b')),
      sbx('orphan', {}, SANDBOX_GRACE_MS + 1),
      sbx('young', {}, 60_000),
    ]
    const tasks = new Map([
      [1, { stage: 'done', run: 'a' }],
      [2, { stage: 'build', run: 'b' }],
    ])
    expect(reapable(listing, facts({ tasks })).map((k) => k.id)).toEqual(['done', 'orphan'])
  })

  it('kills a task sandbox whose run is not the one the task names, or whose task is gone', () => {
    const tasks = new Map([[1, { stage: 'build', run: 'new' }]])
    const killed = reapable(
      [sbx('old', task(1, 'old')), sbx('gone', task(9, 'x'))],
      facts({ tasks }),
    )
    expect(killed.map((k) => k.id)).toEqual(['old', 'gone'])
    expect(killed[0].reason).toContain('another run')
  })

  it('kills an evaluation, a proof or a plan whose process is gone, and keeps one that lives', () => {
    const listing = [
      sbx('eval', metadataFor({ owner: 'eval', caseId: 'c', runId: 'r' }, 'here', 5)),
      sbx('proof', metadataFor({ owner: 'prove-checks', repository: 'a/b' }, 'here', 6)),
      sbx('plan', metadataFor({ owner: 'plan', planId: 1 }, 'here', 7)),
    ]
    const killed = reapable(listing, facts({ alive: (pid) => pid === 6 }))
    expect(killed.map((k) => k.id)).toEqual(['eval', 'plan'])
  })

  it('leaves alone a sandbox another host made, which this one cannot ask about', () => {
    const other = metadataFor({ owner: 'eval', caseId: 'c', runId: 'r' }, 'elsewhere', 5)
    expect(reapable([sbx('x', other)], facts({ alive: () => false }))).toEqual([])
  })

  it('counts the sandboxes with an owner at work', () => {
    const tasks = new Map([[2, { stage: 'verify', run: 'b' }]])
    const listing = [sbx('running', task(2, 'b')), sbx('none', {}), sbx('done', task(3, 'c'))]
    expect(atWork(listing, facts({ tasks }))).toBe(1)
  })
})

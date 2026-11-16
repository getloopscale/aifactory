import { describe, expect, it } from 'vitest'

import type { ListedSandbox } from './sandbox'
import { LEASE_STALE_MS } from './sandbox-lease'
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
  tasks: new Map(),
  leases: new Map([['live', ago(10_000)]]),
  ...over,
})
const made = (owner: Parameters<typeof metadataFor>[0], lease = 'live', host = 'here') =>
  metadataFor(owner, { host, lease })
const task = (taskId: number, run: string, lease = 'live') =>
  made({ owner: 'task', taskId, run }, lease)

describe('metadataFor', () => {
  it('names the owner, the host and the process lease, as strings', () => {
    expect(metadataFor({ owner: 'task', taskId: 4, run: 'r' }, { host: 'h', lease: 'l' })).toEqual({
      owner: 'task',
      taskId: '4',
      run: 'r',
      host: 'h',
      lease: 'l',
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

  it('kills the sandbox of a task still in build when the process that runs it stopped renewing its lease', () => {
    const tasks = new Map([[1, { stage: 'build', run: 'a' }]])
    const dead = sbx('dead', task(1, 'a', 'worker-died'))
    const stale = facts({ tasks, leases: new Map([['worker-died', ago(LEASE_STALE_MS + 1)]]) })
    expect(reapable([dead], stale).map((k) => k.id)).toEqual(['dead'])
    const fresh = facts({ tasks, leases: new Map([['worker-died', ago(LEASE_STALE_MS - 1000)]]) })
    expect(reapable([dead], fresh)).toEqual([])
  })

  it('kills an evaluation, a proof or a plan whose process is gone, on any host, and keeps one that lives', () => {
    const listing = [
      sbx('eval', made({ owner: 'eval', caseId: 'c', runId: 'r' }, 'dead', 'elsewhere')),
      sbx('proof', made({ owner: 'prove-checks', repository: 'a/b' }, 'live', 'elsewhere')),
      sbx('plan', made({ owner: 'plan', planId: 1 }, 'never-registered')),
    ]
    expect(reapable(listing, facts()).map((k) => k.id)).toEqual(['eval', 'plan'])
  })

  it('kills an evaluation with no lease only after the grace', () => {
    const bare = { owner: 'eval', caseId: 'c', runId: 'r' }
    expect(reapable([sbx('a', bare, 60_000)], facts())).toEqual([])
    expect(reapable([sbx('b', bare, SANDBOX_GRACE_MS + 1)], facts()).map((k) => k.id)).toEqual([
      'b',
    ])
  })

  it('counts the sandboxes with an owner at work', () => {
    const tasks = new Map([[2, { stage: 'verify', run: 'b' }]])
    const listing = [sbx('running', task(2, 'b')), sbx('none', {}), sbx('done', task(3, 'c'))]
    expect(atWork(listing, facts({ tasks }))).toBe(1)
  })

  it('keeps a sandbox with metadata the factory did not write, and trusts no stale lease after an outage', () => {
    const other = sbx('other', { team: 'x' }, SANDBOX_GRACE_MS * 2)
    const strange = sbx('strange', { owner: 'someone', lease: 'gone' }, SANDBOX_GRACE_MS * 2)
    expect(reapable([other, strange], facts())).toEqual([])
    const dead = sbx('dead', made({ owner: 'eval', caseId: 'a', runId: 'r' }, 'gone'))
    expect(reapable([dead], facts()).map((k) => k.id)).toEqual(['dead'])
    expect(reapable([dead], facts({ leasesTrusted: false }))).toEqual([])
  })
})

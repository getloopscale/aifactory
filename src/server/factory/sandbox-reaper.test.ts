import { describe, expect, it } from 'vitest'

import type { ListedSandbox } from './sandbox'
import {
  atWork,
  FACTORY_APP,
  metadataFor,
  reapable,
  SANDBOX_GRACE_MS,
  type LeaseFact,
  type ReaperFacts,
} from './sandbox-reaper'

// The windows as the issue states them, written out so a change to the constants fails here.
const GRACE_MS = 10 * 60_000
const QUIET_MS = 2 * 60_000
const NOW = new Date('2026-11-16T18:00:00Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms)
const sbx = (id: string, metadata: Record<string, string>, age = 60_000): ListedSandbox => ({
  id,
  startedAt: ago(age),
  metadata,
})
const lease = (over: Partial<LeaseFact> = {}): LeaseFact => ({
  host: 'here',
  pid: 42,
  beatAt: ago(10_000),
  staleSeenAt: null,
  process: 'alive',
  ...over,
})
const facts = (over: Partial<ReaperFacts> = {}): ReaperFacts => ({
  now: NOW,
  graceMs: SANDBOX_GRACE_MS,
  tasks: new Map(),
  leases: new Map([['live', lease()]]),
  ...over,
})
const made = (owner: Parameters<typeof metadataFor>[0], leaseId = 'live', host = 'here') =>
  metadataFor(owner, { host, lease: leaseId })
const task = (taskId: number, run: string, leaseId = 'live') =>
  made({ owner: 'task', taskId, run }, leaseId)
const killed = (listing: ListedSandbox[], f: ReaperFacts) =>
  reapable(listing, f).kill.map((k) => k.id)

describe('metadataFor', () => {
  it('marks the sandbox as the factory, and names the owner, the host and the process lease, as strings', () => {
    expect(metadataFor({ owner: 'task', taskId: 4, run: 'r' }, { host: 'h', lease: 'l' })).toEqual({
      app: FACTORY_APP,
      owner: 'task',
      taskId: '4',
      run: 'r',
      host: 'h',
      lease: 'l',
    })
    expect(metadataFor(undefined, { host: 'h', lease: 'l' })).toEqual({})
  })
})

describe('reapable', () => {
  it('kills the sandbox of a finished task and one with no metadata past the grace, and keeps a running task', () => {
    const listing = [
      sbx('done', task(1, 'a')),
      sbx('running', task(2, 'b')),
      sbx('orphan', {}, GRACE_MS + 1),
      sbx('young', {}, GRACE_MS),
    ]
    const tasks = new Map([
      [1, { stage: 'done', run: 'a' }],
      [2, { stage: 'build', run: 'b' }],
    ])
    const plan = reapable(listing, facts({ tasks }))
    expect(plan.kill).toEqual([
      { id: 'done', reason: 'task 1 is in done, which holds no sandbox' },
      { id: 'orphan', reason: 'no metadata and older than 10 minutes' },
    ])
    expect(plan.suspect).toEqual([])
  })

  it('kills a task sandbox whose run is not the one the task names, or whose task is gone', () => {
    const tasks = new Map([[1, { stage: 'build', run: 'new' }]])
    const plan = reapable([sbx('old', task(1, 'old')), sbx('gone', task(9, 'x'))], facts({ tasks }))
    expect(plan.kill).toEqual([
      { id: 'old', reason: 'task 1 is on another run than old' },
      { id: 'gone', reason: 'task 9 does not exist' },
    ])
  })

  it('keeps every stage in which a run holds its sandbox', () => {
    const stages = ['sandbox', 'plan', 'build', 'push', 'verify', 'review', 'pr']
    const tasks = new Map(stages.map((stage, i) => [i, { stage, run: 'r' }]))
    expect(
      killed(
        stages.map((_, i) => sbx(`t${i}`, task(i, 'r'))),
        facts({ tasks }),
      ),
    ).toEqual([])
  })

  describe('another application on the same account', () => {
    it('keeps a sandbox whose metadata the factory did not write, however old and whatever it names', () => {
      const old = GRACE_MS * 6
      const listing = [
        sbx('theirs', { team: 'search', job: '7' }, old),
        sbx('same-words', { owner: 'eval', caseId: 'c', runId: 'r', lease: 'unknown' }, old),
        sbx('their-task', { owner: 'task', taskId: '1', run: 'x', lease: 'live' }, old),
        sbx('other-app', { app: 'someone-else', owner: 'eval', lease: 'unknown' }, old),
      ]
      expect(reapable(listing, facts())).toEqual({ kill: [], suspect: [] })
    })

    it('counts none of them as the factory at work', () => {
      expect(atWork([sbx('theirs', { owner: 'eval', lease: 'live' })], facts())).toBe(0)
    })
  })

  describe('a process that died', () => {
    it('is told by its exit, not by its last beat: a fresh lease of a process gone is dead', () => {
      const leases = new Map([['dead', lease({ beatAt: ago(1000), process: 'gone' })]])
      const plan = reapable(
        [sbx('eval', made({ owner: 'eval', caseId: 'c', runId: 'r' }, 'dead'))],
        facts({ leases }),
      )
      expect(plan.kill).toEqual([
        { id: 'eval', reason: 'eval process 42 on here exited (lease dead)' },
      ])
    })

    it('kills a task sandbox still in build when the worker running it exited', () => {
      const tasks = new Map([[1, { stage: 'build', run: 'a' }]])
      const leases = new Map([['worker', lease({ process: 'gone' })]])
      expect(killed([sbx('t', task(1, 'a', 'worker'))], facts({ tasks, leases }))).toEqual(['t'])
    })

    it('kills a factory sandbox whose lease is not recorded, or that names none', () => {
      const plan = reapable(
        [
          sbx('unknown', made({ owner: 'plan', planId: 1 }, 'never-registered')),
          sbx('none', { app: FACTORY_APP, owner: 'prove-checks', repository: 'a/b' }),
        ],
        facts(),
      )
      expect(plan.kill).toEqual([
        { id: 'unknown', reason: 'plan process on here holds no recorded lease never-registered' },
        {
          id: 'none',
          reason: 'prove-checks process on an unknown host holds no recorded lease (none named)',
        },
      ])
    })
  })

  describe('heartbeats missed while the process lives', () => {
    const stale = ago(QUIET_MS + 1)
    const evalOf = (leaseId: string) =>
      sbx(leaseId, made({ owner: 'eval', caseId: 'c', runId: 'r' }, leaseId))

    it('keeps the sandboxes of a process seen alive on this host, however long it has not beaten', () => {
      const leases = new Map([['local', lease({ beatAt: ago(60 * 60_000), process: 'alive' })]])
      expect(reapable([evalOf('local')], facts({ leases }))).toEqual({ kill: [], suspect: [] })
    })

    it('keeps a fresh lease of a process on another host', () => {
      const leases = new Map([['remote', lease({ beatAt: ago(QUIET_MS), process: 'unknown' })]])
      expect(reapable([evalOf('remote')], facts({ leases }))).toEqual({ kill: [], suspect: [] })
    })

    it('only suspects a quiet lease of another host the first time, so a beat after an outage saves it', () => {
      const leases = new Map([
        ['remote', lease({ beatAt: stale, process: 'unknown' })],
        ['other', lease({ beatAt: stale, process: 'unknown' })],
      ])
      const twice = [
        evalOf('remote'),
        sbx('again', made({ owner: 'eval', caseId: 'd', runId: 'r' }, 'remote')),
        evalOf('other'),
      ]
      expect(reapable(twice, facts({ leases }))).toEqual({
        kill: [],
        suspect: [
          { lease: 'remote', beatAt: stale },
          { lease: 'other', beatAt: stale },
        ],
      })
    })

    it('keeps it while the suspicion is younger than the lease window', () => {
      const seen = ago(QUIET_MS - 1)
      const leases = new Map([
        ['remote', lease({ beatAt: stale, staleSeenAt: seen, process: 'unknown' })],
      ])
      expect(reapable([evalOf('remote')], facts({ leases }))).toEqual({ kill: [], suspect: [] })
    })

    it('kills it once it stayed quiet for a whole lease window after a pass suspected it', () => {
      const seen = ago(QUIET_MS)
      const leases = new Map([
        ['remote', lease({ beatAt: stale, staleSeenAt: seen, process: 'unknown' })],
      ])
      expect(reapable([evalOf('remote')], facts({ leases })).kill).toEqual([
        {
          id: 'remote',
          reason: `eval process 42 on here has not renewed lease remote since ${stale.toISOString()}`,
        },
      ])
    })
  })

  it('counts a sandbox whose lease is only suspected as at work', () => {
    const leases = new Map([['remote', lease({ beatAt: ago(QUIET_MS + 1), process: 'unknown' })]])
    const listing = [sbx('s', made({ owner: 'eval', caseId: 'c', runId: 'r' }, 'remote'))]
    expect(atWork(listing, facts({ leases }))).toBe(1)
  })

  it('counts the sandboxes of the factory with an owner at work', () => {
    const tasks = new Map([[2, { stage: 'verify', run: 'b' }]])
    const listing = [sbx('running', task(2, 'b')), sbx('none', {}), sbx('done', task(3, 'c'))]
    expect(atWork(listing, facts({ tasks }))).toBe(1)
  })
})

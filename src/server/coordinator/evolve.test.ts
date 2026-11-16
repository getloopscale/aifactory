import { describe, expect, it } from 'vitest'

import {
  DESIGNED_WAITS,
  EVOLVE,
  effectComment,
  evolveLog,
  groupBySignature,
  isDesignedWait,
  issueForSignature,
  measurable,
  reasonOf,
  signatureOf,
  toFile,
  type FailureEvent,
  type SignatureGroup,
} from './evolve'

const DAY = 86_400_000
const NOW = new Date('2026-11-15T12:00:00Z')
const ago = (days: number) => new Date(NOW.getTime() - days * DAY)

let ids = 0
const event = (reason: string, over: Partial<FailureEvent> = {}): FailureEvent => {
  ids += 1
  return {
    taskId: ids,
    repository: 'paulo/app',
    issueNumber: 100 + ids,
    stage: 'failed',
    reason,
    at: ago(1),
    ...over,
  }
}

describe('signatureOf', () => {
  it('replaces numbers and commit ids, so two reasons that differ only there share it', () => {
    const a = signatureOf('push of 3fa9c01 rejected after 3 attempts')
    const b = signatureOf('push of 0be27d4e9a1 rejected after 12 attempts')
    expect(a).toBe('push of <sha> rejected after <n> attempts')
    expect(b).toBe(a)
  })

  it('replaces commit ids of 7 to 40 characters and leaves shorter or longer hex alone', () => {
    expect(signatureOf('at a1b2c3d')).toBe('at <sha>')
    expect(signatureOf(`at ${'a1'.repeat(20)}`)).toBe('at <sha>')
    expect(signatureOf('at a1b2c3')).toBe('at a<n>b<n>c<n>')
    expect(signatureOf(`at ${'a1'.repeat(20)}f`)).not.toContain('<sha>')
  })

  it('leaves a word made only of hex letters, which has no digit', () => {
    expect(signatureOf('the defaced cafebabe value')).toBe('the defaced cafebabe value')
  })

  it('replaces commit ids in capitals too', () => {
    expect(signatureOf('at A1B2C3D')).toBe('at <sha>')
  })

  it('replaces paths, relative and absolute', () => {
    expect(signatureOf('cannot read src/server/x.ts')).toBe('cannot read <path>')
    expect(signatureOf('cannot read /tmp/run-12/out.log')).toBe('cannot read <path>')
    expect(signatureOf('cannot read ./a/b')).toBe('cannot read <path>')
    expect(signatureOf('cannot read ~/a/b')).toBe('cannot read <path>')
  })

  it('replaces URLs before anything inside them is read as a path or a number', () => {
    expect(signatureOf('see https://github.com/o/r/pull/12 now')).toBe('see <url> now')
    expect(signatureOf('see http://x.test/a?b=1')).toBe('see <url>')
  })

  it('keeps the first line with text, its spaces collapsed, and cuts it to a length', () => {
    expect(signatureOf('\n  checks   failed:\n\nnpm ERR 1')).toBe('checks failed:')
    expect(signatureOf('   \nchecks failed')).toBe('checks failed')
    expect(signatureOf('x'.repeat(500))).toHaveLength(EVOLVE.signatureLength)
  })

  it('writes long dashes as hyphens', () => {
    expect(signatureOf('lost \u2014 then \u2013 again')).toBe('lost - then - again')
  })

  it('is empty for a reason with no text', () => {
    expect(signatureOf('  \n ')).toBe('')
  })
})

describe('reasonOf', () => {
  it('reads the reason, then the error, and nothing else', () => {
    expect(reasonOf({ reason: 'r', error: 'e' })).toBe('r')
    expect(reasonOf({ error: 'e' })).toBe('e')
    expect(reasonOf({ reason: 3 })).toBe('')
    expect(reasonOf({ reason: '', error: 'e' })).toBe('e')
    expect(reasonOf(null)).toBe('')
  })
})

describe('isDesignedWait', () => {
  it('knows a task blocked by another issue and one waiting for an answer', () => {
    expect(DESIGNED_WAITS).toEqual(['blocked by', 'waiting for an answer'])
    expect(isDesignedWait('blocked by #<n>, still open')).toBe(true)
    expect(isDesignedWait('Blocked by #<n>')).toBe(true)
    expect(isDesignedWait('waiting for an answer')).toBe(true)
    expect(isDesignedWait('the push was blocked by a hook')).toBe(false)
  })
})

describe('groupBySignature', () => {
  it('groups by signature, counts distinct tasks and keeps the first and last time seen', () => {
    const groups = groupBySignature([
      event('lost 1', { taskId: 1, at: ago(3) }),
      event('lost 2', { taskId: 1, at: ago(2) }),
      event('lost 3', { taskId: 2, at: ago(1) }),
      event('other', { taskId: 3 }),
      event('', { taskId: 4 }),
    ])
    expect(groups).toHaveLength(2)
    const lost = groups.find((g) => g.signature === 'lost <n>')!
    expect(lost.tasks).toBe(2)
    expect(lost.events).toHaveLength(3)
    expect(lost.firstSeen).toEqual(ago(3))
    expect(lost.lastSeen).toEqual(ago(1))
  })

  it('orders the events of a group by time', () => {
    const [g] = groupBySignature([event('x', { at: ago(1) }), event('x', { at: ago(4) })])
    expect(g.events.map((e) => e.at)).toEqual([ago(4), ago(1)])
    expect(g.firstSeen).toEqual(ago(4))
  })
})

const threeTasks = (reason: (i: number) => string, at = ago(1)) =>
  [1, 2, 3].map((i) => event(reason(i), { at: new Date(at.getTime() + i) }))

describe('toFile', () => {
  it('files a signature on three distinct tasks', () => {
    const groups = groupBySignature(threeTasks((i) => `push of ${i}abcdef${i} failed ${i}`))
    expect(toFile(groups, new Set(), 0).map((g) => g.signature)).toEqual([
      'push of <sha> failed <n>',
    ])
  })

  it('files nothing for two tasks', () => {
    const groups = groupBySignature([event('x'), event('x')])
    expect(toFile(groups, new Set(), 0)).toEqual([])
  })

  it('files nothing for a signature that already has an issue', () => {
    const groups = groupBySignature(threeTasks(() => 'x'))
    expect(toFile(groups, new Set(['x']), 0)).toEqual([])
  })

  it('files nothing for a designed wait', () => {
    const groups = groupBySignature(threeTasks((i) => `blocked by #${i}, still open`))
    expect(toFile(groups, new Set(), 0)).toEqual([])
  })

  it('files one of five, the one on the most tasks', () => {
    const groups = groupBySignature([
      ...['a', 'b', 'c', 'd'].flatMap((s) => threeTasks(() => s)),
      ...[1, 2, 3, 4].map(() => event('e', { at: ago(0.5) })),
    ])
    expect(toFile(groups, new Set(), 0).map((g) => g.signature)).toEqual(['e'])
  })

  it('between signatures on as many tasks, files the one seen first, then by name', () => {
    const groups = groupBySignature([
      ...threeTasks(() => 'late', ago(1)),
      ...threeTasks(() => 'early', ago(3)),
    ])
    expect(toFile(groups, new Set(), 0).map((g) => g.signature)).toEqual(['early'])
    const tied = groupBySignature([
      ...threeTasks(() => 'b', ago(2)),
      ...threeTasks(() => 'a', ago(2)),
    ])
    expect(toFile(tied, new Set(), 0).map((g) => g.signature)).toEqual(['a'])
  })

  it('files nothing once three issues were filed in the week, and one with two', () => {
    const groups = groupBySignature(threeTasks(() => 'x'))
    expect(toFile(groups, new Set(), 3)).toEqual([])
    expect(toFile(groups, new Set(), 2)).toHaveLength(1)
  })

  it('files nothing when more than three were filed in the week', () => {
    const groups = groupBySignature([...threeTasks(() => 'x'), ...threeTasks(() => 'y')])
    expect(toFile(groups, new Set(), 4)).toEqual([])
  })
})

const group = (over: Partial<SignatureGroup> = {}): SignatureGroup => ({
  ...groupBySignature([
    event('push of 3fa9c01 failed \u2014 twice', { taskId: 7, issueNumber: 41, at: ago(3) }),
    event('push of 0be27d4 failed \u2014 twice', {
      taskId: 8,
      repository: 'paulo/web',
      issueNumber: 42,
      stage: 'handoff',
      at: ago(1),
    }),
  ])[0],
  ...over,
})

describe('issueForSignature', () => {
  const { title, body } = issueForSignature(group())

  it('names the signature in the title', () => {
    expect(title).toBe(
      'coordinator: the same failure ended 2 tasks in 7 days: push of <sha> failed - twice',
    )
  })

  it('carries the signature, each task with its event, reason and time, and when it was first and last seen', () => {
    expect(body).toContain('push of <sha> failed - twice')
    expect(body).toContain('Task 7, paulo/app#41, failed at 2026-11-12T12:00:00.000Z')
    expect(body).toContain('Task 8, paulo/web#42, handoff at 2026-11-14T12:00:00.000Z')
    expect(body).toContain('push of 3fa9c01 failed - twice')
    expect(body).toContain(
      'First seen: 2026-11-12T12:00:00.000Z. Last seen: 2026-11-14T12:00:00.000Z.',
    )
    expect(body).toContain('## Repro')
  })

  it('quotes the signature in a plain fence when it has no tilde', () => {
    expect(body).toContain('\n~~~text\npush of <sha> failed - twice\n~~~\n')
  })

  it('says nothing of more events when every event is listed', () => {
    const all = groupBySignature(Array.from({ length: EVOLVE.eventsListed }, () => event('x')))[0]
    expect(issueForSignature(all).body).not.toContain('more events')
    expect(issueForSignature(all).body).toContain('~~~\n\n## Repro')
  })

  it('has no em dash, even where a reason had one', () => {
    expect(body).not.toMatch(/[\u2014\u2013]/)
    expect(title).not.toMatch(/[\u2014\u2013]/)
  })

  it('quotes a reason in a fence longer than any it contains, so it renders as text', () => {
    const { body: fenced } = issueForSignature(
      groupBySignature([event('out:\n~~~~text\n@someone failed\n~~~~')])[0],
    )
    expect(fenced).toContain('~~~~~text\nout:\n~~~~text\n@someone failed\n~~~~\n~~~~~')
  })

  it('quotes at most a length of each reason and lists at most a number of events', () => {
    const many = groupBySignature(
      Array.from({ length: EVOLVE.eventsListed + 2 }, () => event(`x ${'y'.repeat(900)}`)),
    )[0]
    const { body: long } = issueForSignature(many)
    expect(long.match(/^- Task /gm)).toHaveLength(EVOLVE.eventsListed)
    expect(long).toContain('And 2 more events.')
    expect(long).not.toContain('y'.repeat(EVOLVE.reasonQuoted))
    expect(long).toContain('y'.repeat(EVOLVE.reasonQuoted - 2))
  })

  it('cuts a long signature in the title', () => {
    const { title: cut } = issueForSignature(group({ signature: 's'.repeat(300) }))
    expect(cut.length).toBeLessThanOrEqual(EVOLVE.titleLength)
  })
})

describe('effectComment', () => {
  it('says nothing when the failure stopped after the close', () => {
    expect(effectComment('x', 6, 0)).toBeUndefined()
  })

  it('names both counts when the failure still happens after the close, even when it fell', () => {
    const comment = effectComment('x', 6, 5)!
    expect(comment).toContain('6 times in the 7 days before this issue was filed')
    expect(comment).toContain('5 in the 7 days after it closed')
    expect(effectComment('x', 2, 5)).toContain('5 in the 7 days after')
    expect(effectComment('x', 0, 1)).toContain('0 times in the 7 days before')
    expect(comment).not.toMatch(/[\u2014\u2013]/)
  })
})

describe('measurable', () => {
  const closedAt = ago(7)
  it('is measurable once the seven days after the close have passed', () => {
    expect(measurable({ state: 'closed', closedAt }, NOW)).toBe(true)
    expect(measurable({ state: 'closed', closedAt: new Date(closedAt.getTime() + 1) }, NOW)).toBe(
      false,
    )
  })

  it('is not measurable while the issue is open, or without a close time', () => {
    expect(measurable({ state: 'open', closedAt }, NOW)).toBe(false)
    expect(measurable({ state: 'closed' }, NOW)).toBe(false)
    expect(measurable({}, NOW)).toBe(false)
  })
})

describe('evolveLog', () => {
  const empty = { filed: [], wouldFile: [], measured: [], failed: [] }

  it('logs nothing for a quiet pass', () => {
    expect(evolveLog(empty, 'auto')).toEqual([])
  })

  it('logs what a trial pass would file', () => {
    const lines = evolveLog(
      { ...empty, wouldFile: [{ signature: 'x', taskIds: [1, 2, 3] }] },
      'trial',
    )
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      {
        event: 'coordinator_evolve',
        mode: 'trial',
        filed: [],
        wouldFile: [{ signature: 'x', taskIds: [1, 2, 3] }],
        measured: [],
        failed: [],
      },
    ])
  })

  it('logs a pass that only measured or only failed', () => {
    const measured = [{ signature: 'x', issueNumber: 3, before: 6, after: 0, commented: false }]
    expect(evolveLog({ ...empty, measured }, 'auto')).toHaveLength(1)
    expect(evolveLog({ ...empty, failed: [{ signature: 'x', error: 'e' }] }, 'auto')).toHaveLength(
      1,
    )
    expect(
      evolveLog({ ...empty, filed: [{ signature: 'x', issueNumber: 4 }] }, 'auto'),
    ).toHaveLength(1)
  })
})

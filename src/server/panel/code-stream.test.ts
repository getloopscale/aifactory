import { describe, expect, it } from 'vitest'

import type { Database } from '../db'

import { codeSince } from './stream'

type Row = { sessionId: string; seq: number }

/**
 * A stand-in for the reads `codeSince` makes: the head of each session, then, for each session whose head is
 * past its cursor and in the order of the heads, that session's events after the cursor.
 */
function fakeDb(committed: Row[], cursor: Map<string, number>) {
  let queue: string[] = []
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    groupBy: async () => {
      const heads = new Map<string, number>()
      for (const r of committed)
        heads.set(r.sessionId, Math.max(heads.get(r.sessionId) ?? 0, r.seq))
      queue = [...heads].filter(([id, head]) => head > (cursor.get(id) ?? 0)).map(([id]) => id)
      return [...heads].map(([sessionId, seq]) => ({ sessionId, seq }))
    },
    limit: async () => {
      const id = queue.shift()
      return committed
        .filter((r) => r.sessionId === id && r.seq > (cursor.get(id!) ?? 0))
        .map((r) => ({ ...r, kind: 'agent_message', tool: null, content: '', at: new Date(0) }))
    },
  }
  return { select: () => chain } as unknown as Database
}

const sent = (events: Awaited<ReturnType<typeof codeSince>>) =>
  events.flatMap((e) => (e.type === 'code' ? [`${e.sessionId}${e.event.seq}`] : []))

describe('codeSince', () => {
  it('keeps a cursor per session and moves it past what it sent', async () => {
    const cursor = new Map<string, number>()
    const db = fakeDb([{ sessionId: 'a', seq: 1 }], cursor)
    expect(sent(await codeSince(db, cursor))).toEqual(['a1'])
    expect(cursor.get('a')).toBe(1)
    expect(await codeSince(db, cursor)).toEqual([])
  })

  it('sends events of interleaved sessions, none twice and none missed', async () => {
    const committed: Row[] = [
      { sessionId: 'a', seq: 1 },
      { sessionId: 'b', seq: 1 },
    ]
    const cursor = new Map([['a', 1]])
    const db = fakeDb(committed, cursor)
    expect(sent(await codeSince(db, cursor))).toEqual(['b1'])
    committed.push(
      { sessionId: 'a', seq: 2 },
      { sessionId: 'b', seq: 2 },
      { sessionId: 'a', seq: 3 },
    )
    expect(sent(await codeSince(db, cursor))).toEqual(['a2', 'a3', 'b2'])
    expect(await codeSince(db, cursor)).toEqual([])
  })

  it('sends nothing for an append that rolled back: it left no row, so no head moved', async () => {
    const cursor = new Map([['a', 1]])
    const db = fakeDb([{ sessionId: 'a', seq: 1 }], cursor)
    expect(await codeSince(db, cursor)).toEqual([])
    expect(cursor.get('a')).toBe(1)
  })
})

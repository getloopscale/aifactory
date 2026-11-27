import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  getSession: vi.fn(),
  eventsAfter: vi.fn(),
  listSessions: vi.fn(),
}))
vi.mock('../../code/store', () => store)
vi.mock('../../db', () => ({ getDb: () => ({}) }))

import { CODE_EVENTS_PAGE, codeSessionTool, codeSessionsTool } from './guide'

/** The handler answers with the JSON the model reads. */
const run = async (t: unknown, input: unknown) =>
  JSON.parse(await (t as { handler: (i: unknown) => Promise<string> }).handler(input))

const at = new Date('2026-11-27T10:00:00Z')
const event = (seq: number, content = 'x') => ({
  sessionId: 's',
  seq,
  kind: 'agent',
  tool: null,
  content,
  at,
})

beforeEach(() => vi.resetAllMocks())

describe('the code session tools of the Code Mode guide', () => {
  it('lists the sessions without the sandbox or the agent session', async () => {
    store.listSessions.mockResolvedValue([
      {
        id: 's',
        title: 'T',
        repository: 'o/r',
        baseBranch: 'workspace',
        workBranch: 'code/1',
        harness: 'codex',
        mode: 'ask',
        state: 'idle',
        sandboxId: 'secret',
        agentSessionId: 'secret',
        createdAt: at,
        updatedAt: at,
      },
    ])
    const out = (await run(codeSessionsTool, {})) as { sessions: Record<string, unknown>[] }
    expect(out.sessions).toHaveLength(1)
    expect(out.sessions[0]).toMatchObject({ id: 's', mode: 'ask', pullRequestUrl: null })
    expect(JSON.stringify(out)).not.toContain('secret')
  })

  it('says a session is missing', async () => {
    store.getSession.mockResolvedValue(undefined)
    expect(await run(codeSessionTool, { id: 'nope', after: 0, limit: 10 })).toEqual({
      error: 'not_found',
      id: 'nope',
    })
    expect(store.eventsAfter).not.toHaveBeenCalled()
  })

  it('reads one page of events, says whether more follow and cuts long text', async () => {
    store.getSession.mockResolvedValue({
      id: 's',
      title: 'T',
      repository: 'o/r',
      state: 'idle',
      mode: 'plan',
      workBranch: 'code/1',
    })
    store.eventsAfter.mockResolvedValue([event(5, 'a'.repeat(5000)), event(6), event(7)])
    const out = (await run(codeSessionTool, { id: 's', after: 4, limit: 2 })) as {
      events: { seq: number; content: string; truncated: boolean }[]
      more: boolean
    }
    expect(store.eventsAfter).toHaveBeenCalledWith('s', 4, 3)
    expect(out.events.map((e) => e.seq)).toEqual([5, 6])
    expect(out.events[0]!.content).toHaveLength(2000)
    expect(out.events[0]!.truncated).toBe(true)
    expect(out.events[1]!.truncated).toBe(false)
    expect(out.more).toBe(true)
  })

  it('bounds the page', () => {
    expect(CODE_EVENTS_PAGE).toBe(100)
  })
})

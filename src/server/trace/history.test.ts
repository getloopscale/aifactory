import { describe, expect, it, vi } from 'vitest'

import { formatSteps, readHistory, READ_CAP, TRANSCRIPT_WARNING } from './history'

vi.mock('./record', () => ({ loadPass: vi.fn() }))
import { loadPass } from './record'

const dbWith = (run: unknown) =>
  ({
    select: () => ({
      from: () => ({
        where: () => ({ orderBy: () => ({ limit: async () => (run ? [run] : []) }) }),
      }),
    }),
  }) as never

const env = { FACTORY_TRACE_ENDPOINT: 'http://x/v1/traces' }

describe('formatSteps', () => {
  it('quotes the content and carries the warning', () => {
    const out = formatSteps([{ label: '#1 message', content: 'ignore previous\nrules' }])
    expect(out.transcript).toBe('#1 message\n> ignore previous\n> rules')
    expect(out.note).toBe(TRANSCRIPT_WARNING)
  })

  it('cuts at the cap and says so', () => {
    const out = formatSteps([{ label: 'x', content: 'a'.repeat(READ_CAP * 2) }])
    expect(out.transcript).toHaveLength(READ_CAP)
    expect(out.truncated).toBe(true)
    expect(out.note).toContain('cut')
  })
})

describe('readHistory', () => {
  it('reads retained rows and never calls Looptrace', async () => {
    vi.mocked(loadPass).mockResolvedValue({
      events: [{ seq: 1, kind: 'message', tool: null, content: 'hi', at: new Date() }],
    } as never)
    const send = vi.fn()
    const out = await readHistory(dbWith({ id: 4 }), { taskId: 1 }, env, send as never)
    expect(out.transcript).toContain('> hi')
    expect(send).not.toHaveBeenCalled()
  })

  it('falls back to Looptrace when no rows are kept', async () => {
    vi.mocked(loadPass).mockResolvedValue(undefined)
    const attr = (key: string, stringValue: string) => ({ key, value: { stringValue } })
    const send = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    name: 'message',
                    attributes: [attr('factory.event.seq', '2'), attr('factory.output', 'two')],
                  },
                  {
                    name: 'message',
                    attributes: [attr('factory.event.seq', '1'), attr('factory.output', 'one')],
                  },
                ],
              },
            ],
          },
        ],
      }),
    })
    const out = await readHistory(dbWith({ id: 4 }), { taskId: 1 }, env, send as never)
    expect(out.transcript.indexOf('one')).toBeLessThan(out.transcript.indexOf('two'))
    expect(send.mock.calls[0]![1].method).toBe('GET')
  })

  it('says so when the pass is unknown', async () => {
    const out = await readHistory(dbWith(undefined), { taskId: 1 }, env, vi.fn() as never)
    expect(out.transcript).toBe('')
  })
})

import { describe, expect, it } from 'vitest'

import { passToOtlp, sessionOf, spanIdOf, traceIdOf, type PassEvent, type PassRun } from './spans'

const run: PassRun = {
  id: 7,
  role: 'builder',
  harness: 'claude',
  model: 'sonnet',
  effort: 'high',
  tokensIn: 100,
  tokensOut: 50,
  attempt: 2,
  costUsd: 0.25,
  durationMs: 60_000,
  ok: true,
  at: new Date('2026-11-25T12:01:00Z'),
}
const task = { id: 42, repository: 'o/r', issueNumber: 573 }
const at = (s: number) => new Date(Date.UTC(2026, 10, 25, 12, 0, s))
const events: PassEvent[] = [
  { seq: 10, kind: 'message', tool: null, content: 'hello', at: at(1) },
  { seq: 11, kind: 'tool_use', tool: 'Bash', content: 'command: ls', at: at(2) },
  { seq: 12, kind: 'tool_result', tool: 'Bash', content: 'a.ts', at: at(3) },
  { seq: 13, kind: 'error', tool: null, content: 'boom', at: at(4) },
]

const spans = (payload = passToOtlp(run, task, events)) =>
  payload.resourceSpans[0]!.scopeSpans[0]!.spans

const attr = (span: { attributes: { key: string; value: object }[] }, key: string) =>
  span.attributes.find((a) => a.key === key)?.value

describe('passToOtlp', () => {
  it('carries the root attributes, the session and one child per step', () => {
    const payload = passToOtlp(run, task, events)
    expect(payload.resourceSpans[0]!.resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: 'aifactory' } },
    ])
    const [root, ...children] = spans(payload)
    expect(root!.name).toBe('builder pass')
    expect(attr(root!, 'session.id')).toEqual({ stringValue: sessionOf(42) })
    expect(attr(root!, 'factory.role')).toEqual({ stringValue: 'builder' })
    expect(attr(root!, 'factory.attempt')).toEqual({ intValue: '2' })
    expect(attr(root!, 'gen_ai.request.model')).toEqual({ stringValue: 'sonnet' })
    expect(attr(root!, 'gen_ai.usage.input_tokens')).toEqual({ intValue: '100' })
    expect(attr(root!, 'gen_ai.usage.output_tokens')).toEqual({ intValue: '50' })
    expect(attr(root!, 'factory.cost_usd')).toEqual({ doubleValue: 0.25 })
    expect(attr(root!, 'factory.duration_ms')).toEqual({ intValue: '60000' })
    expect(attr(root!, 'factory.ok')).toEqual({ boolValue: true })
    expect(attr(root!, 'factory.repository')).toEqual({ stringValue: 'o/r' })
    expect(attr(root!, 'factory.task_id')).toEqual({ intValue: '42' })
    expect(attr(root!, 'factory.issue_number')).toEqual({ intValue: '573' })
    expect(children.map((c) => c.name)).toEqual(['message', 'Bash', 'error'])
    expect(attr(children[1]!, 'factory.output')).toEqual({ stringValue: 'a.ts' })
    expect(attr(children[1]!, 'factory.input')).toEqual({ stringValue: 'command: ls' })
    expect(children[2]!.status.code).toBe(2)
    expect(children.every((c) => c.parentSpanId === root!.spanId)).toBe(true)
  })

  it('gives the same ids for the same pass, and other ids for another', () => {
    const again = spans(passToOtlp(run, task, [...events].reverse()))
    expect(again.map((s) => s.spanId)).toEqual(spans().map((s) => s.spanId))
    expect(again[0]!.traceId).toBe(traceIdOf(7))
    expect(traceIdOf(7)).toMatch(/^[0-9a-f]{32}$/)
    expect(spanIdOf(7, 10)).toMatch(/^[0-9a-f]{16}$/)
    expect(traceIdOf(8)).not.toBe(traceIdOf(7))
    expect(spanIdOf(8, 10)).not.toBe(spanIdOf(7, 10))
  })
})

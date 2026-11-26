import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  fetchTrace,
  searchHistory,
  searchPasses,
  SEARCH_LIMIT,
  TraceUnavailable,
  type LookupTasks,
  type TaskFacts,
} from './search'
import { traceIdOf } from './spans'

let server: Server
let urls: string[]
let reply: { status: number; body: unknown }
let env: Record<string, string>

beforeEach(async () => {
  urls = []
  reply = { status: 200, body: { traces: [] } }
  server = createServer((req, res) => {
    urls.push(req.url ?? '')
    res.statusCode = reply.status
    res.end(JSON.stringify(reply.body))
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  env = {
    FACTORY_TRACE_ENDPOINT: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`,
  }
})
afterEach(() => new Promise((ok) => server.close(ok)))

const facts = (taskId: number, repository: string): TaskFacts => ({
  taskId,
  issueNumber: taskId + 100,
  displayIdentifier: null,
  title: `Task ${taskId}`,
  repository,
  runs: [
    { id: taskId * 10, role: 'builder', attempt: 1, costUsd: 0.1, at: '2026-01-01T00:00:00Z' },
  ],
})
const lookup: LookupTasks = async () =>
  new Map([
    [1, facts(1, 'o/a')],
    [2, facts(2, 'o/b')],
  ])
const trace = (session: string, run = 10) => ({
  trace_id: traceIdOf(run),
  session_id: session,
  input_preview: 'in',
  output_preview: 'out',
})

describe('searchHistory', () => {
  it('is off with no endpoint, and asks nothing', async () => {
    expect(await searchHistory({ q: 'ab', page: 1 }, lookup, {})).toEqual({
      enabled: false,
      variable: 'FACTORY_TRACE_ENDPOINT',
    })
    expect(urls).toEqual([])
  })

  it("keeps Looptrace's order, drops a session with no task and forwards only its fields", async () => {
    reply.body = { traces: [trace('task:2', 20), trace('task:99'), trace('task:1', 10)] }
    const report = await searchHistory(
      { q: 'needle', page: 2, from: '2026-01-01T00:00:00Z' },
      lookup,
      env,
    )
    expect(report).toMatchObject({ enabled: true, page: 2, hasMore: false })
    if (!report.enabled) throw new Error('off')
    expect(report.results.map((r) => r.taskId)).toEqual([2, 1])
    expect(report.results[0]).toMatchObject({
      runId: 20,
      role: 'builder',
      attempt: 1,
      traceUrl: null,
    })
    expect([...new URL(urls[0]!, 'http://x').searchParams.keys()].sort()).toEqual([
      'from',
      'limit',
      'offset',
      'q',
    ])
  })

  it('filters by repository and links the trace when the UI address is set', async () => {
    reply.body = { traces: [trace('task:1', 10), trace('task:2', 20)] }
    const report = await searchHistory({ q: 'ab', page: 1, repository: 'o/b' }, lookup, {
      ...env,
      FACTORY_TRACE_UI_URL: 'http://lt/',
    })
    if (!report.enabled) throw new Error('off')
    expect(report.results.map((r) => r.repository)).toEqual(['o/b'])
    expect(report.results[0]!.traceUrl).toBe(`http://lt/traces/${traceIdOf(20)}`)
  })

  it('rejects an answer that does not match, whole', async () => {
    reply.body = { traces: [trace('task:1'), { nope: true }] }
    await expect(searchHistory({ q: 'ab', page: 1 }, lookup, env)).rejects.toBeInstanceOf(
      TraceUnavailable,
    )
  })

  it('rejects a refusal', async () => {
    reply = { status: 500, body: {} }
    await expect(searchHistory({ q: 'ab', page: 1 }, lookup, env)).rejects.toBeInstanceOf(
      TraceUnavailable,
    )
  })

  it('gives an assistant at most 10 passes when Looptrace lists 50', async () => {
    const many: LookupTasks = async () => new Map([[1, facts(1, 'o/a')]])
    reply.body = { traces: Array.from({ length: 50 }, () => trace('task:1', 10)) }
    const report = await searchPasses({ q: 'ab' }, many, env)
    expect(report.enabled && report.results).toHaveLength(SEARCH_LIMIT)
  })

  it('fetchTrace is undefined on 404 and with no endpoint', async () => {
    reply = { status: 404, body: {} }
    expect(await fetchTrace('abc', env)).toBeUndefined()
    expect(await fetchTrace('abc', {})).toBeUndefined()
  })
})

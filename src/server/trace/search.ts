import { inArray } from 'drizzle-orm'
import { z } from 'zod'

import type { Database } from '../db'
import { agentRun, task } from '../db/schema'
import type { HistoryReport, HistoryResult } from '../../shared/panel'

import { traceEndpoint, type TraceEnv } from './export'
import { traceIdOf } from './spans'

export const PAGE_SIZE = 20

export type HistoryQuery = {
  q: string
  repository?: string
  role?: string
  from?: string
  to?: string
  /** 1-based. */
  page: number
}

/** Looptrace did not answer, or its answer is not what the panel reads. The route answers 502 for it. */
export class TraceUnavailable extends Error {}

/**
 * Looptrace's `GET /v1/traces` answer, as assumed (its source was not reachable): `traces`, each with the trace
 * and session ids, a start time and the previews. An answer that does not match is rejected whole.
 */
const answerSchema = z.object({
  traces: z.array(
    z.object({
      trace_id: z.string(),
      session_id: z.string().nullish(),
      start_time: z.string().nullish(),
      cost_usd: z.number().nullish(),
      input_preview: z.string().nullish(),
      output_preview: z.string().nullish(),
    }),
  ),
})
type Trace = z.infer<typeof answerSchema>['traces'][number]

export type TaskFacts = {
  taskId: number
  issueNumber: number
  displayIdentifier: string | null
  title: string
  repository: string
  runs: { id: number; role: string; attempt: number; costUsd: number | null; at: string }[]
}

export type LookupTasks = (ids: number[]) => Promise<Map<number, TaskFacts>>

export const lookupTasks =
  (db: Database): LookupTasks =>
  async (ids) => {
    const facts = new Map<number, TaskFacts>()
    if (ids.length === 0) return facts
    const tasks = await db.select().from(task).where(inArray(task.id, ids))
    for (const t of tasks) {
      facts.set(t.id, {
        taskId: t.id,
        issueNumber: t.issueNumber,
        displayIdentifier: t.displayIdentifier,
        title: t.issueTitle,
        repository: t.repository,
        runs: [],
      })
    }
    const runs = await db.select().from(agentRun).where(inArray(agentRun.taskId, ids))
    for (const r of runs) {
      facts.get(r.taskId!)?.runs.push({
        id: r.id,
        role: r.role,
        attempt: r.attempt,
        costUsd: r.costUsd,
        at: r.at.toISOString(),
      })
    }
    return facts
  }

const taskOf = (session: string | null | undefined): number | undefined => {
  const match = /^task:(\d+)$/.exec(session ?? '')
  return match ? Number(match[1]) : undefined
}

async function readPage(
  url: string,
  query: HistoryQuery,
  offset: number,
  env: TraceEnv,
  send: typeof fetch,
): Promise<Trace[]> {
  // Only these fields ever reach Looptrace.
  const params = new URLSearchParams({
    q: query.q,
    limit: String(PAGE_SIZE),
    offset: String(offset),
  })
  if (query.from) params.set('from', query.from)
  if (query.to) params.set('to', query.to)
  const token = env.FACTORY_TRACE_TOKEN?.trim()
  let response: Response
  try {
    response = await send(`${url}?${params}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    throw new TraceUnavailable(`Looptrace did not answer: ${String(error)}`)
  }
  if (!response.ok) throw new TraceUnavailable(`Looptrace answered ${response.status}`)
  const parsed = answerSchema.safeParse(await response.json().catch(() => undefined))
  if (!parsed.success)
    throw new TraceUnavailable('Looptrace answered something the panel cannot read')
  return parsed.data.traces
}

const traceLink = (id: string, env: TraceEnv): string | null => {
  const base = env.FACTORY_TRACE_UI_URL?.trim()
  return base ? `${base.replace(/\/+$/, '')}/traces/${encodeURIComponent(id)}` : null
}

/**
 * Searches Looptrace for the passes whose content matches, in its order, as the tasks they belong to. A trace
 * whose session names no known task is dropped. One page is one Looptrace page; the repository and role filters
 * apply after it answers, so a page can be short while `hasMore` says Looptrace has more.
 */
export async function searchHistory(
  query: HistoryQuery,
  lookup: LookupTasks,
  env: TraceEnv = process.env,
  send: typeof fetch = fetch,
): Promise<HistoryReport> {
  const url = traceEndpoint(env)
  if (!url) return { enabled: false, variable: 'FACTORY_TRACE_ENDPOINT' }
  const results: HistoryResult[] = []
  const traces = await readPage(url, query, (query.page - 1) * PAGE_SIZE, env, send)
  {
    const facts = await lookup(
      [...new Set(traces.map((t) => taskOf(t.session_id)))].filter(
        (id): id is number => id !== undefined,
      ),
    )
    for (const trace of traces) {
      const found = facts.get(taskOf(trace.session_id) ?? -1)
      if (!found) continue
      if (query.repository && found.repository !== query.repository) continue
      const run = found.runs.find((r) => traceIdOf(r.id) === trace.trace_id)
      if (query.role && run?.role !== query.role) continue
      results.push({
        taskId: found.taskId,
        issueNumber: found.issueNumber,
        displayIdentifier: found.displayIdentifier,
        title: found.title,
        repository: found.repository,
        runId: run?.id ?? null,
        role: run?.role ?? null,
        attempt: run?.attempt ?? null,
        at: trace.start_time ?? run?.at ?? null,
        costUsd: trace.cost_usd ?? run?.costUsd ?? null,
        inputPreview: trace.input_preview ?? '',
        outputPreview: trace.output_preview ?? '',
        traceUrl: traceLink(trace.trace_id, env),
      })
    }
  }
  const hasMore = traces.length === PAGE_SIZE
  return { enabled: true, results, page: query.page, hasMore }
}

/** The most passes an assistant is given for one search. */
export const SEARCH_LIMIT = 10

/** At most `SEARCH_LIMIT` passes, whatever Looptrace lists, for the assistants' `history_search`. */
export async function searchPasses(
  query: Omit<HistoryQuery, 'page'>,
  lookup: LookupTasks,
  env: TraceEnv = process.env,
  send: typeof fetch = fetch,
): Promise<HistoryReport> {
  const report = await searchHistory({ ...query, page: 1 }, lookup, env, send)
  return report.enabled ? { ...report, results: report.results.slice(0, SEARCH_LIMIT) } : report
}

/** The OTLP JSON of one trace, or undefined when search is off or Looptrace does not have it. Reads only. */
export async function fetchTrace(
  traceId: string,
  env: TraceEnv = process.env,
  send: typeof fetch = fetch,
): Promise<unknown | undefined> {
  const base = traceEndpoint(env)
  if (!base) return undefined
  const token = env.FACTORY_TRACE_TOKEN?.trim()
  const response = await send(`${base.replace(/\/+$/, '')}/${encodeURIComponent(traceId)}`, {
    method: 'GET',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(15_000),
  })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`the trace endpoint answered ${response.status}`)
  return response.json()
}

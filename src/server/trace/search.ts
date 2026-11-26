import { traceEndpoint, type TraceEnv } from './export'

/**
 * Reads Looptrace; never writes. The endpoint is the complete traces URL (`/v1/traces`). Assumed, since
 * Looptrace's source was not reachable: `GET <endpoint>?q=&repository=&role=&from=&to=&limit=` answers
 * `{ traces: [{ traceId, startTime, preview, attributes }] }`, and `GET <endpoint>/<traceId>` answers the OTLP
 * JSON the `export-trace` job sent.
 */

export const SEARCH_LIMIT = 10

export type SearchQuery = {
  query: string
  repository?: string
  role?: string
  /** ISO dates. */
  from?: string
  to?: string
}

export type SearchHit = {
  traceId: string
  taskId: number | null
  issueNumber: number | null
  title: string | null
  repository: string | null
  role: string | null
  attempt: number | null
  at: string | null
  preview: string
}

export type SearchAnswer = { enabled: false } | { enabled: true; hits: SearchHit[] }

const headers = (env: TraceEnv): Record<string, string> => {
  const token = env.FACTORY_TRACE_TOKEN?.trim()
  return token ? { authorization: `Bearer ${token}` } : {}
}

const text = (v: unknown) => (typeof v === 'string' ? v : null)
const num = (v: unknown) => (typeof v === 'number' ? v : null)

function toHit(raw: unknown): SearchHit | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const a = (r.attributes && typeof r.attributes === 'object' ? r.attributes : {}) as Record<
    string,
    unknown
  >
  const traceId = text(r.traceId)
  if (!traceId) return undefined
  return {
    traceId,
    taskId: num(a['factory.task_id']),
    issueNumber: num(a['factory.issue_number']),
    title: text(a['factory.issue_title']),
    repository: text(a['factory.repository']),
    role: text(a['factory.role']),
    attempt: num(a['factory.attempt']),
    at: text(r.startTime),
    preview: (text(r.preview) ?? '').slice(0, 300),
  }
}

/** At most `SEARCH_LIMIT` passes, whatever the server lists. */
export async function searchHistory(
  q: SearchQuery,
  env: TraceEnv = process.env,
  send: typeof fetch = fetch,
): Promise<SearchAnswer> {
  const base = traceEndpoint(env)
  if (!base) return { enabled: false }
  const url = new URL(base)
  url.searchParams.set('q', q.query)
  for (const [key, value] of [
    ['repository', q.repository],
    ['role', q.role],
    ['from', q.from],
    ['to', q.to],
  ] as const) {
    if (value) url.searchParams.set(key, value)
  }
  url.searchParams.set('limit', String(SEARCH_LIMIT))
  const response = await send(url, {
    method: 'GET',
    headers: headers(env),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`the trace endpoint answered ${response.status}`)
  const body = (await response.json()) as { traces?: unknown }
  const list = Array.isArray(body.traces) ? body.traces : []
  const hits = list.flatMap((t) => toHit(t) ?? []).slice(0, SEARCH_LIMIT)
  return { enabled: true, hits }
}

/** The OTLP JSON of one trace, or undefined when search is off or Looptrace does not have it. */
export async function fetchTrace(
  traceId: string,
  env: TraceEnv = process.env,
  send: typeof fetch = fetch,
): Promise<unknown | undefined> {
  const base = traceEndpoint(env)
  if (!base) return undefined
  const response = await send(`${base.replace(/\/+$/, '')}/${encodeURIComponent(traceId)}`, {
    method: 'GET',
    headers: headers(env),
    signal: AbortSignal.timeout(15_000),
  })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`the trace endpoint answered ${response.status}`)
  return response.json()
}

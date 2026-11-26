/**
 * Posts an OTLP JSON payload to Looptrace. Only the `export-trace` job calls it (`import-boundary.test.ts`):
 * a run never waits for the export. The endpoint is the complete traces URL, `/v1/traces` included.
 */

export type TraceEnv = Record<string, string | undefined>

export const traceEndpoint = (env: TraceEnv = process.env): string | undefined =>
  env.FACTORY_TRACE_ENDPOINT?.trim() || undefined

/** Throws on any answer but a 2xx, so the queue retries the job. With no endpoint set, sends nothing. */
export async function exportTrace(
  payload: unknown,
  env: TraceEnv = process.env,
  send: typeof fetch = fetch,
): Promise<boolean> {
  const url = traceEndpoint(env)
  if (!url) return false
  const token = env.FACTORY_TRACE_TOKEN?.trim()
  const response = await send(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`the trace endpoint answered ${response.status}`)
  return true
}

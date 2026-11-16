const MAX_DEPTH = 4
const MAX_CAUSES = 8

const NETWORK_CODE =
  /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_\w+)\b/

/** One link of a cause chain, with its code when it has one. */
function describe(value: unknown): string {
  if (!(value instanceof Error)) return String(value)
  const code = (value as { code?: unknown }).code
  return typeof code === 'string' && !value.message.includes(code)
    ? `${code} ${value.message}`.trim()
    : value.message
}

/**
 * The text of an error, with what caused it: `fetch failed` alone says nothing, `fetch failed (cause:
 * ENOTFOUND getaddrinfo ENOTFOUND api.github.com)` says why. The error's own message stays first.
 */
export function errorMessage(error: unknown): string {
  const causes: string[] = []
  const seen = new Set<unknown>([error])
  const visit = (value: unknown, depth: number): void => {
    if (!(value instanceof Error) || depth >= MAX_DEPTH) return
    const next: unknown[] = []
    if (value instanceof AggregateError) next.push(...value.errors)
    if (value.cause !== undefined && value.cause !== null) next.push(value.cause)
    for (const item of next) {
      if (seen.has(item) || causes.length >= MAX_CAUSES) continue
      seen.add(item)
      const text = describe(item)
      if (text !== '' && !causes.includes(text)) causes.push(text)
      visit(item, depth + 1)
    }
  }
  visit(error, 0)
  const own = describe(error)
  return causes.length === 0 ? own : `${own} (cause: ${causes.join(' <- ')})`
}

/** Whether a thrown error is the network failing, not the request being wrong: worth asking again. */
export function isTransientFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error instanceof TypeError && error.message === 'fetch failed') return true
  return NETWORK_CODE.test(errorMessage(error))
}

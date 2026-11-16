const MAX_DEPTH = 4

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
  let cause = error instanceof Error ? error.cause : undefined
  while (cause !== undefined && cause !== null && !seen.has(cause) && causes.length < MAX_DEPTH) {
    seen.add(cause)
    const text = describe(cause)
    if (text !== '') causes.push(text)
    cause = cause instanceof Error ? cause.cause : undefined
  }
  if (error instanceof AggregateError) {
    for (const inner of error.errors) {
      if (causes.length >= MAX_DEPTH * 2) break
      const text = describe(inner)
      if (text !== '' && !causes.includes(text)) causes.push(text)
    }
  }
  const own = describe(error)
  return causes.length === 0 ? own : `${own} (cause: ${causes.join(' <- ')})`
}

/** Whether a thrown error is the network failing, not the request being wrong: worth asking again. */
export function isTransientFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error instanceof TypeError && error.message === 'fetch failed') return true
  return NETWORK_CODE.test(errorMessage(error))
}

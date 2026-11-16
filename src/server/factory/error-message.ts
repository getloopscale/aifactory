/**
 * What a failed run says about its error. Node's `fetch` throws a `TypeError` whose message is only
 * "fetch failed" and keeps the reason (a refused connection, a reset, a DNS failure) in `cause`, so a task
 * recorded the same bare words whatever went wrong. The cause is appended, which keeps the original words
 * first, so what matches "fetch failed" still does.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause
  if (cause === undefined || cause === null) return error.message
  const detail = causeText(cause)
  return detail === '' || error.message.includes(detail)
    ? error.message
    : `${error.message}: ${detail}`
}

function causeText(cause: unknown): string {
  if (!(cause instanceof Error)) return typeof cause === 'string' ? cause : ''
  const code = (cause as { code?: unknown }).code
  const prefix = typeof code === 'string' && !cause.message.includes(code) ? `${code} ` : ''
  return `${prefix}${cause.message}`.trim()
}

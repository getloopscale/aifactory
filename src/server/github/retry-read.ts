import { isTransientFetchError } from '../factory/error-message'

export const READ_ATTEMPTS = 3
export const READ_RETRY_MS = 2_000

/**
 * Asks again, with a growing pause, when GitHub answers a read with a 5xx or the network drops it. A call
 * that changes something is made once. The last answer, or the last error, is what the caller gets.
 */
export async function retryRead(
  send: () => Promise<Response>,
  wait: (ms: number) => Promise<void>,
  isRead: boolean,
): Promise<Response> {
  for (let attempt = 1; ; attempt += 1) {
    const last = attempt >= READ_ATTEMPTS
    let response: Response
    try {
      response = await send()
    } catch (error) {
      if (!isRead || last || !isTransientFetchError(error)) throw error
      await wait(READ_RETRY_MS * attempt)
      continue
    }
    if (!isRead || response.status < 500 || last) return response
    await wait(READ_RETRY_MS * attempt)
  }
}

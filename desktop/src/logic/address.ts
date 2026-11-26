export type AddressCheck = { ok: true; origin: string } | { ok: false; reason: string }

/** The origin of what the owner typed: a bare host gets `https://`, a path or query is dropped. */
export function parseAddress(input: string): AddressCheck {
  const text = input.trim()
  if (text === '') return { ok: false, reason: 'Type the address of the panel.' }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return { ok: false, reason: `"${text}" is not an address.` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `Only http and https addresses are allowed, not ${url.protocol}` }
  }
  return { ok: true, origin: url.origin }
}

/** Whether a body answered by `/api/health` has the factory's shape. */
export function isFactoryHealth(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false
  const b = body as Record<string, unknown>
  return b.status === 'ok' && b.framework === 'TheoKit'
}

/** Checks an origin by reading its `/api/health`. `fetcher` is `fetch` in the app and a fake in tests. */
export async function checkAddress(
  input: string,
  fetcher: (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>,
): Promise<AddressCheck> {
  const parsed = parseAddress(input)
  if (!parsed.ok) return parsed
  let response
  try {
    response = await fetcher(`${parsed.origin}/api/health`)
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `${parsed.origin} did not answer: ${why}` }
  }
  if (!response.ok) {
    return { ok: false, reason: `${parsed.origin}/api/health answered ${response.status}.` }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { ok: false, reason: `${parsed.origin}/api/health did not answer JSON.` }
  }
  if (!isFactoryHealth(body)) {
    return {
      ok: false,
      reason: `${parsed.origin} is not the factory's panel: /api/health answered another shape.`,
    }
  }
  return { ok: true, origin: parsed.origin }
}

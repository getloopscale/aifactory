import { createHmac, timingSafeEqual } from 'node:crypto'

/** Linear refuses a delivery older than a minute; so does the factory (replay guard). */
export const MAX_AGE_MS = 60_000

/** Whether `signature` (hex HMAC-SHA256 of the raw body, header `linear-signature`) is valid. */
export function verifyLinearSignature(rawBody: string, signature: string | null, secret: string) {
  if (!signature) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest()
  const given = Buffer.from(signature, 'hex')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export type LinearWebhookDeps = {
  /** `LINEAR_WEBHOOK_SECRET`. Without it the endpoint refuses everything. */
  secret: string | undefined
  /** Stores a verified delivery; `decideIngress` decides it inside the recording transaction. */
  record: (delivery: { deliveryId: string; payload: unknown }) => Promise<unknown>
  now?: () => number
}

/** The events the factory reads are small; a larger body is refused before it is read whole. */
const MAX_BODY_BYTES = 1_000_000

/** Verifies the signature over the raw body first; an invalid one answers 401 and records nothing. */
export async function handleLinearDelivery(
  request: Request,
  deps: LinearWebhookDeps,
): Promise<Response> {
  if (!deps.secret) return Response.json({ error: 'webhook_not_configured' }, { status: 503 })
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) {
    return Response.json({ error: 'payload_too_large' }, { status: 413 })
  }
  const rawBody = await request.text()
  if (!verifyLinearSignature(rawBody, request.headers.get('linear-signature'), deps.secret)) {
    return Response.json({ error: 'invalid_signature' }, { status: 401 })
  }
  const deliveryId = request.headers.get('linear-delivery')
  if (!deliveryId) return Response.json({ error: 'missing_headers' }, { status: 400 })
  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const stamp = (payload as { webhookTimestamp?: unknown } | null)?.webhookTimestamp
  if (typeof stamp === 'number' && Math.abs((deps.now ?? Date.now)() - stamp) > MAX_AGE_MS) {
    return Response.json({ error: 'stale_delivery' }, { status: 401 })
  }
  return Response.json(await deps.record({ deliveryId, payload }))
}

import { createHmac, timingSafeEqual } from 'node:crypto'

import { z } from 'zod'

/** Linear signs the raw body with HMAC-SHA256 and sends it hex in `linear-signature`. */
export function verifyLinearSignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest()
  const given = Buffer.from(signature, 'hex')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** What the owner set in the panel: the label, and the repository each Linear team maps to. */
export type LinearSettings = {
  label: string
  teams: Record<string, { repository: string; enabled: boolean }>
}

const payload = z.object({
  type: z.string(),
  action: z.string(),
  data: z.object({
    id: z.string(),
    identifier: z.string().optional(),
    title: z.string().optional(),
    teamId: z.string().optional(),
    labels: z.array(z.object({ name: z.string() })).default([]),
  }),
})

export type LinearDecision =
  | {
      accept: true
      code: 'issue_labeled'
      repository: string
      itemId: string
      identifier: string | null
      title: string
    }
  | {
      accept: false
      code:
        | 'payload_invalid'
        | 'event_not_issues'
        | 'action_not_relevant'
        | 'label_not_factory'
        | 'team_not_mapped'
        | 'repository_disabled'
      repository: string | null
    }

/** Decides over a verified Linear delivery. A labelled item is not permission: its team maps to an enabled repository. */
export function decideLinearIngress(body: unknown, settings: LinearSettings): LinearDecision {
  const parsed = payload.safeParse(body)
  if (!parsed.success) return { accept: false, code: 'payload_invalid', repository: null }
  const { type, action, data } = parsed.data
  if (type !== 'Issue') return { accept: false, code: 'event_not_issues', repository: null }
  if (action !== 'create' && action !== 'update') {
    return { accept: false, code: 'action_not_relevant', repository: null }
  }
  const mapped = data.teamId ? settings.teams[data.teamId] : undefined
  if (!data.labels.some((l) => l.name === settings.label)) {
    return { accept: false, code: 'label_not_factory', repository: mapped?.repository ?? null }
  }
  if (!mapped) return { accept: false, code: 'team_not_mapped', repository: null }
  if (!mapped.enabled) {
    return { accept: false, code: 'repository_disabled', repository: mapped.repository }
  }
  return {
    accept: true,
    code: 'issue_labeled',
    repository: mapped.repository,
    itemId: data.id,
    identifier: data.identifier ?? null,
    title: data.title ?? '',
  }
}

export type LinearWebhookDeps = {
  /** `LINEAR_WEBHOOK_SECRET`. Without it the endpoint refuses everything. */
  secret: string | undefined
  settings: () => Promise<LinearSettings>
  /** Records the delivery (source-scoped id) and its decision; the route's transaction creates the task. */
  record: (delivery: {
    deliveryId: string
    decision: LinearDecision
    payload: unknown
  }) => Promise<unknown>
}

/** Verifies the signature over the raw bytes first; an invalid one answers 401 and records nothing. */
export async function handleLinearDelivery(
  request: Request,
  deps: LinearWebhookDeps,
): Promise<Response> {
  if (!deps.secret) return Response.json({ error: 'webhook_not_configured' }, { status: 503 })
  const raw = await request.text()
  if (!verifyLinearSignature(raw, request.headers.get('linear-signature'), deps.secret)) {
    return Response.json({ error: 'invalid_signature' }, { status: 401 })
  }
  const deliveryId = request.headers.get('linear-delivery')
  if (!deliveryId) return Response.json({ error: 'missing_headers' }, { status: 400 })
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const decision = decideLinearIngress(body, await deps.settings())
  return Response.json(
    await deps.record({ deliveryId: `linear:${deliveryId}`, decision, payload: body }),
  )
}

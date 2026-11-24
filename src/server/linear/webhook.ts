import { createHmac, timingSafeEqual } from 'node:crypto'

import { z } from 'zod'

/** Linear refuses a delivery older than a minute; so does the factory (replay guard). */
export const MAX_AGE_MS = 60_000

/** Whether `signature` (hex HMAC-SHA256 of the raw body, header `linear-signature`) is valid. */
export function verifyLinearSignature(rawBody: string, signature: string | null, secret: string) {
  if (!signature) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest()
  const given = Buffer.from(signature, 'hex')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

const issueData = z.object({
  id: z.string(),
  identifier: z.string().optional(),
  title: z.string(),
  teamId: z.string().optional(),
  team: z.object({ id: z.string() }).optional(),
  labelIds: z.array(z.string()).default([]),
  labels: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
  completedAt: z.string().nullish(),
  canceledAt: z.string().nullish(),
})

const payload = z.object({
  action: z.enum(['create', 'update', 'remove']),
  type: z.literal('Issue'),
  data: issueData,
  updatedFrom: z
    .object({ labelIds: z.array(z.string()).optional() })
    .partial()
    .optional(),
  webhookTimestamp: z.number().optional(),
})

/** The owner's settings: the label that asks for work and where each team's work goes. */
export type LinearSettings = {
  /** The Linear label id that asks the factory to take an item. */
  labelId: string
  /** Linear team id to `owner/repo`. */
  teams: Record<string, string>
}

export type LinearDecision =
  | {
      accept: true
      code: 'item_labeled'
      repository: string
      itemId: string
      display: string
      title: string
      reason: string
    }
  | {
      accept: false
      code: 'payload_invalid' | 'action_not_relevant' | 'label_not_factory' | 'team_not_mapped'
      reason: string
      repository: string | null
    }

/**
 * Decides what a Linear delivery asks for. An item is taken when it carries the configured label (new,
 * or the label was just added) and its team maps to a repository. Whether that repository is enabled is
 * checked when the delivery is recorded, as for GitHub: a label is not permission.
 */
export function decideLinearIngress(body: unknown, settings: LinearSettings): LinearDecision {
  const parsed = payload.safeParse(body)
  if (!parsed.success) {
    return {
      accept: false,
      code: 'payload_invalid',
      reason: z.prettifyError(parsed.error),
      repository: null,
    }
  }
  const { action, data, updatedFrom } = parsed.data
  if (action === 'remove') {
    return { accept: false, code: 'action_not_relevant', reason: 'item removed', repository: null }
  }
  const ids = new Set([...data.labelIds, ...(data.labels?.map((l) => l.id) ?? [])])
  if (!ids.has(settings.labelId)) {
    return {
      accept: false,
      code: 'label_not_factory',
      reason: 'item lacks the configured label',
      repository: null,
    }
  }
  // An update is a request only when it just added the label.
  if (
    action === 'update' &&
    (!updatedFrom?.labelIds || updatedFrom.labelIds.includes(settings.labelId))
  ) {
    return {
      accept: false,
      code: 'action_not_relevant',
      reason: 'the label was not just added',
      repository: null,
    }
  }
  const team = data.teamId ?? data.team?.id
  const repository = team ? settings.teams[team] : undefined
  if (!repository) {
    return {
      accept: false,
      code: 'team_not_mapped',
      reason: `team ${team ?? '?'} maps to no repository`,
      repository: null,
    }
  }
  const display = data.identifier ?? data.id
  return {
    accept: true,
    code: 'item_labeled',
    repository,
    itemId: data.id,
    display,
    title: data.title,
    reason: `${display} carries the configured label`,
  }
}

export type LinearWebhookDeps = {
  secret: string | undefined
  settings: () => Promise<LinearSettings>
  /** Stores a verified, decided delivery (deduplicated by delivery id). */
  record: (delivery: {
    deliveryId: string
    payload: unknown
    decision: LinearDecision
  }) => Promise<unknown>
  now?: () => number
}

/** Verifies the signature over the raw body first; an invalid one answers 401 and records nothing. */
export async function handleLinearDelivery(
  request: Request,
  deps: LinearWebhookDeps,
): Promise<Response> {
  if (!deps.secret) return Response.json({ error: 'webhook_not_configured' }, { status: 503 })
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
  const stamp = (payload as { webhookTimestamp?: unknown }).webhookTimestamp
  if (typeof stamp === 'number' && Math.abs((deps.now ?? Date.now)() - stamp) > MAX_AGE_MS) {
    return Response.json({ error: 'stale_delivery' }, { status: 401 })
  }
  const decision = decideLinearIngress(payload, await deps.settings())
  return Response.json(await deps.record({ deliveryId, payload, decision }))
}

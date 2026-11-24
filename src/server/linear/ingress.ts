import { createHmac, timingSafeEqual } from 'node:crypto'

import { z } from 'zod'

/** The label an item carries to ask for work when the repository's mapping names none. */
export const DEFAULT_LINEAR_LABEL = 'factory'

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

/** What a decision needs to know of an item. A webhook may omit some of it; the adapter reads the rest. */
export type LinearFacts = {
  itemId: string
  identifier: string
  url: string
  title: string
  teamId: string
  labels: string[]
}

const payload = z.object({
  type: z.string(),
  action: z.string(),
  url: z.string().optional(),
  data: z.object({
    id: z.string(),
    identifier: z.string().optional(),
    title: z.string().optional(),
    teamId: z.string().optional(),
    team: z.object({ id: z.string() }).optional(),
    labels: z.array(z.object({ name: z.string() })).optional(),
  }),
})

export type LinearIgnoreCode =
  | 'payload_invalid'
  | 'event_not_issues'
  | 'action_not_relevant'
  | 'label_not_factory'
  | 'team_not_mapped'
  | 'repository_disabled'

/** What the delivery says on its own: an item to look at, or a reason to ignore it without any API call. */
export type LinearPrefilter =
  { ignore: LinearIgnoreCode; reason: string } | { itemId: string; known: Partial<LinearFacts> }

export function prefilterLinear(body: unknown): LinearPrefilter {
  const parsed = payload.safeParse(body)
  if (!parsed.success) return { ignore: 'payload_invalid', reason: 'not a Linear webhook payload' }
  const { type, action, data, url } = parsed.data
  if (type !== 'Issue') return { ignore: 'event_not_issues', reason: `${type} is not an issue` }
  if (action !== 'create' && action !== 'update') {
    return { ignore: 'action_not_relevant', reason: `${action} asks for nothing` }
  }
  const teamId = data.teamId ?? data.team?.id
  return {
    itemId: data.id,
    known: {
      itemId: data.id,
      ...(data.identifier ? { identifier: data.identifier } : {}),
      ...(url ? { url } : {}),
      ...(data.title ? { title: data.title } : {}),
      ...(teamId ? { teamId } : {}),
      ...(data.labels ? { labels: data.labels.map((l) => l.name) } : {}),
    },
  }
}

/** Whether the payload carries every fact the decision needs. When it does not, they are read from Linear. */
export const isComplete = (known: Partial<LinearFacts>): known is LinearFacts =>
  known.teamId !== undefined &&
  known.labels !== undefined &&
  known.title !== undefined &&
  known.identifier !== undefined &&
  known.url !== undefined

/** The repository the owner mapped a team to, with its label. */
export type LinearMapping = { repository: string; enabled: boolean; label: string | null }

export type LinearDecision =
  | { accept: true; code: 'issue_labeled'; reason: string; repository: string; facts: LinearFacts }
  | { accept: false; code: LinearIgnoreCode; reason: string; repository: string | null }

/** A labelled item is not permission: its team must map to a repository the owner enabled. */
export function decideLinearItem(
  facts: LinearFacts,
  mapping: LinearMapping | undefined,
): LinearDecision {
  if (!mapping) {
    return {
      accept: false,
      code: 'team_not_mapped',
      reason: `Linear team ${facts.teamId} is not mapped to a repository`,
      repository: null,
    }
  }
  const label = mapping.label ?? DEFAULT_LINEAR_LABEL
  if (!facts.labels.includes(label)) {
    return {
      accept: false,
      code: 'label_not_factory',
      reason: `the item does not carry the ${label} label`,
      repository: mapping.repository,
    }
  }
  if (!mapping.enabled) {
    return {
      accept: false,
      code: 'repository_disabled',
      reason: `${mapping.repository} is not enabled for the factory: enable it in the panel`,
      repository: mapping.repository,
    }
  }
  return {
    accept: true,
    code: 'issue_labeled',
    reason: `${facts.identifier} carries the ${label} label in ${mapping.repository}`,
    repository: mapping.repository,
    facts,
  }
}

export type LinearWebhookDeps = {
  /** `LINEAR_WEBHOOK_SECRET`. Without it the endpoint refuses everything. */
  secret: string | undefined
  /** Records a verified delivery under its source-scoped id; may throw when Linear cannot be read. */
  record: (delivery: { deliveryId: string; payload: unknown }) => Promise<unknown>
}

/**
 * Verifies the signature over the raw bytes first: an invalid one answers 401 and records nothing. A delivery
 * whose facts could not be read answers 502 and records nothing, so Linear sends it again.
 */
export async function handleLinearDelivery(
  request: Request,
  { secret, record }: LinearWebhookDeps,
): Promise<Response> {
  if (!secret) return Response.json({ error: 'webhook_not_configured' }, { status: 503 })
  const raw = await request.text()
  if (!verifyLinearSignature(raw, request.headers.get('linear-signature'), secret)) {
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
  try {
    return Response.json(await record({ deliveryId: `linear:${deliveryId}`, payload: body }))
  } catch (error) {
    console.error(JSON.stringify({ event: 'linear_delivery_failed', error: String(error) }))
    return Response.json({ error: 'delivery_not_recorded' }, { status: 502 })
  }
}

import { z } from 'zod'

/** The event name a Linear delivery is recorded under. */
export const LINEAR_EVENT = 'linear.Issue'

/** The owner's settings: the label that asks for work and where each team's work goes. */
export type LinearSettings = {
  /** The Linear label id that asks the factory to take an item. */
  labelId: string
  /** Linear team id to `owner/repo`. */
  teams: Record<string, string>
}

const payload = z.object({
  action: z.enum(['create', 'update', 'remove']),
  type: z.literal('Issue'),
  data: z.object({
    id: z.string(),
    identifier: z.string().optional(),
    title: z.string(),
    teamId: z.string().optional(),
    team: z.object({ id: z.string() }).optional(),
    labelIds: z.array(z.string()).default([]),
    labels: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
  }),
  updatedFrom: z
    .object({ labelIds: z.array(z.string()).optional() })
    .partial()
    .optional(),
})

export type LinearDecision =
  | {
      accept: true
      code: 'item_labeled'
      reason: string
      repository: string
      itemId: string
      display: string
      title: string
    }
  | {
      accept: false
      code: 'payload_invalid' | 'action_not_relevant' | 'label_not_factory' | 'team_not_mapped'
      reason: string
      repository: null
    }

const no = (code: Exclude<LinearDecision, { accept: true }>['code'], reason: string) =>
  ({ accept: false, code, reason, repository: null }) as const

/**
 * What a Linear delivery asks for, called by `decideIngress`. An item is taken when it carries the configured
 * label (new, or the label was just added) and its team maps to a repository. Whether that repository is
 * enabled is checked when the delivery is recorded: a label is not permission.
 */
export function decideLinear(body: unknown, settings: LinearSettings | undefined): LinearDecision {
  const parsed = payload.safeParse(body)
  if (!parsed.success) return no('payload_invalid', z.prettifyError(parsed.error))
  if (!settings) return no('label_not_factory', 'no Linear label is configured')
  const { action, data, updatedFrom } = parsed.data
  if (action === 'remove') return no('action_not_relevant', 'item removed')
  const ids = new Set([...data.labelIds, ...(data.labels?.map((l) => l.id) ?? [])])
  if (!ids.has(settings.labelId)) return no('label_not_factory', 'item lacks the configured label')
  // An update is a request only when it just added the label.
  if (
    action === 'update' &&
    (!updatedFrom?.labelIds || updatedFrom.labelIds.includes(settings.labelId))
  ) {
    return no('action_not_relevant', 'the label was not just added')
  }
  const team = data.teamId ?? data.team?.id
  const repository = team ? Object.hasOwn(settings.teams, team) && settings.teams[team] : undefined
  if (!repository) return no('team_not_mapped', `team ${team ?? '?'} maps to no repository`)
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

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
    state: z.object({ type: z.string() }).optional(),
  }),
  updatedFrom: z
    .object({
      labelIds: z.array(z.string()).optional(),
      stateId: z.string().optional(),
      completedAt: z.string().nullish(),
      canceledAt: z.string().nullish(),
    })
    .partial()
    .optional(),
  // The person who made the change, when Linear names one.
  actor: z.object({ name: z.string().optional() }).optional(),
})

/** What happened to an item that may stop its run, by the kinds `transitions.ts` knows. */
export type LinearChange = 'issue_unlabeled' | 'issue_closed' | 'issue_reopened'

/** A routed Linear delivery: it starts no task, and names the item by its Linear id. */
export type LinearIntent = {
  kind: LinearChange
  repository: string
  linearItemId: string
  actorLogin: string
}

export type LinearDecision =
  | {
      accept: false
      code: LinearChange
      reason: string
      repository: string
      intent: LinearIntent
    }
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

const no = (
  code: 'payload_invalid' | 'action_not_relevant' | 'label_not_factory' | 'team_not_mapped',
  reason: string,
) => ({ accept: false, code, reason, repository: null }) as const

/**
 * What a Linear delivery asks for, called by `decideIngress`. An item is taken when it carries the configured
 * label (new, or the label was just added) and its team maps to a repository. Whether that repository is
 * enabled is checked when the delivery is recorded: a label is not permission.
 */
export function decideLinear(body: unknown, settings: LinearSettings | undefined): LinearDecision {
  const parsed = payload.safeParse(body)
  if (!parsed.success) return no('payload_invalid', z.prettifyError(parsed.error))
  if (!settings) return no('label_not_factory', 'no Linear label is configured')
  const { action, data, updatedFrom, actor } = parsed.data
  const team = data.teamId ?? data.team?.id
  const mapped = team && Object.hasOwn(settings.teams, team) ? settings.teams[team] : undefined
  const display = data.identifier ?? data.id
  const change = (kind: LinearChange, what: string): LinearDecision => ({
    accept: false,
    code: kind,
    reason: `${display} ${what}`,
    repository: mapped ?? `linear:${team ?? '?'}`,
    intent: {
      kind,
      repository: mapped ?? `linear:${team ?? '?'}`,
      linearItemId: data.id,
      actorLogin: actor?.name ?? 'linear',
    },
  })
  const ids = new Set([...data.labelIds, ...(data.labels?.map((l) => l.id) ?? [])])
  if (action === 'remove') return change('issue_closed', 'was removed')
  if (!ids.has(settings.labelId)) {
    if (updatedFrom?.labelIds?.includes(settings.labelId)) {
      return change('issue_unlabeled', 'lost the configured label')
    }
    return no('label_not_factory', 'item lacks the configured label')
  }
  // A change of state, while the label is on: done or cancelled stops the task, back to open brings it up again.
  if (updatedFrom?.stateId !== undefined) {
    if (data.state?.type === 'completed' || data.state?.type === 'canceled') {
      return change('issue_closed', 'was completed or cancelled')
    }
    if (updatedFrom.completedAt || updatedFrom.canceledAt) {
      return change('issue_reopened', 'was reopened')
    }
  }
  // An update is a request only when it just added the label.
  if (
    action === 'update' &&
    (!updatedFrom?.labelIds || updatedFrom.labelIds.includes(settings.labelId))
  ) {
    return no('action_not_relevant', 'the label was not just added')
  }
  const repository = mapped
  if (!repository) return no('team_not_mapped', `team ${team ?? '?'} maps to no repository`)
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

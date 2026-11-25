import { createHash } from 'node:crypto'

import { z } from 'zod'

import { refOf } from '../factory/blockers'
import { jsonObjects } from '../factory/review'

/**
 * Whether a queued issue is ready to build, without its side effects: what the assistant reads, how its
 * answer is read, and what a pass does with a verdict. `judge.ts` calls the model and `apply.ts` asks the
 * owner. An answer that cannot be read lets the task run, with the error recorded: an issue is never held
 * back by an answer nobody could read.
 */

export type ReadinessVerdict = 'ready' | 'needs_refinement' | 'blocked'

export const readinessSchema = z.object({
  verdict: z.enum(['ready', 'needs_refinement', 'blocked']),
  missing: z.string(),
  question: z.string(),
  blockedBy: z.array(z.string()).optional(),
  reason: z.string().optional(),
})

/** Why an issue needs refinement. A reason the code does not know is `owner_decision`. */
export type RefinementReason = 'no_acceptance' | 'several_changes' | 'owner_decision'

export type Readiness = {
  verdict: ReadinessVerdict
  missing: string
  question: string
  /** With `blocked`: the open issues it waits for, as `owner/repo#number`, which a pass can read again. */
  blockedBy?: string[]
  /**
   * With `needs_refinement`: `no_acceptance` or `several_changes`. Absent means `owner_decision`, which is what
   * a missing or unknown reason is read as (`refinementReason`).
   */
  reason?: Exclude<RefinementReason, 'owner_decision'>
  /** Why the answer could not be read, when it could not: the verdict is then `ready`. */
  error?: string
}

const READY_BY_DEFAULT = { verdict: 'ready', missing: '', question: '' } as const

const unreadable = (error: string): Readiness => ({ ...READY_BY_DEFAULT, error })

function readCandidate(candidate: string): Readiness {
  let value: unknown
  try {
    value = JSON.parse(candidate)
  } catch (error) {
    return unreadable(`the answer is not JSON: ${(error as Error).message}`)
  }
  const parsed = readinessSchema.safeParse(value)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
    return unreadable(`the answer is not a readiness verdict: ${issues.join('; ')}`)
  }
  const { verdict, missing, question } = parsed.data
  if (verdict === 'needs_refinement' && question.trim() === '') {
    return unreadable('a needs_refinement answer must carry a question for the owner')
  }
  if (verdict === 'blocked') {
    const named = missing.trim()
    if (named === '') return unreadable('a blocked answer must name what is missing')
    const blockedBy = [
      ...new Set((parsed.data.blockedBy ?? []).filter((n) => refOf(n.trim())).map((n) => n.trim())),
    ]
    const asked = question.trim() || 'Can what is missing be provided, or should the issue change?'
    return {
      verdict,
      missing: named,
      question: asked,
      ...(blockedBy.length > 0 ? { blockedBy } : {}),
    }
  }
  const reason = parsed.data.reason?.trim()
  const known =
    reason === 'no_acceptance' || reason === 'several_changes' ? ({ reason } as const) : {}
  return {
    verdict,
    missing: missing.trim(),
    question: question.trim(),
    ...(verdict === 'needs_refinement' ? known : {}),
  }
}

/** The reason of a recorded or parsed verdict; an older verdict, with none, needs the owner. */
export const refinementReason = (r: { reason?: string }): RefinementReason =>
  r.reason === 'no_acceptance' || r.reason === 'several_changes' ? r.reason : 'owner_decision'

export const ACCEPTANCE_HEADING = '## Acceptance (drafted by the factory)'
const CRITERIA_MIN = 2
const CRITERIA_MAX = 6
const CRITERION_MAX = 500

/** The criteria in the drafter's answer: its last JSON object that holds them, or none with the error. */
export function parseCriteria(answer: string): { criteria: string[]; error?: string } {
  const candidates = jsonObjects(answer)
  if (candidates.length === 0) return { criteria: [], error: 'the answer holds no JSON object' }
  for (const candidate of [...candidates].reverse()) {
    let value: unknown
    try {
      value = JSON.parse(candidate)
    } catch {
      continue
    }
    const parsed = z.object({ criteria: z.array(z.string()) }).safeParse(value)
    if (!parsed.success) continue
    const criteria = parsed.data.criteria
      .map((c) => c.replace(/\s+/g, ' ').trim().slice(0, CRITERION_MAX))
      .filter((c) => c !== '')
    if (criteria.length === 0) return { criteria: [] }
    if (criteria.length < CRITERIA_MIN || criteria.length > CRITERIA_MAX) {
      return { criteria: [], error: `the draft has ${criteria.length} criteria, not 2 to 6` }
    }
    return { criteria }
  }
  return { criteria: [], error: 'the answer is not a list of criteria' }
}

/** A criterion as plain list text: one line, with nothing that Markdown would turn into structure. */
const plainCriterion = (text: string): string =>
  text
    .replace(/[\\`*_~<>[\]|#!]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[-+\d.)\s]+/, '')
    .trim()

/** The section appended to the issue body. */
export function acceptanceSection(criteria: string[]): string {
  const items = criteria.map(plainCriterion).filter((c) => c !== '')
  return [ACCEPTANCE_HEADING, '', ...items.map((c) => `- ${c}`)].join('\n')
}

/** The verdict in the assistant's answer: its last JSON object that is one, or `ready` with the error. */
export function parseReadiness(answer: string): Readiness {
  const candidates = jsonObjects(answer)
  if (candidates.length === 0) return unreadable('the answer holds no JSON object')
  const read = candidates.map(readCandidate)
  return [...read].reverse().find((r) => r.error === undefined) ?? read[read.length - 1]
}

/** The version of an issue a verdict is for: the same title and body are judged once. */
export const bodyHash = (title: string, body: string): string =>
  createHash('sha256')
    .update(JSON.stringify([title, body]))
    .digest('hex')

const BODY_MAX = 12_000

/** The message the assistant gets. The body sits inside markers, as data. */
export function readinessMessage(issue: {
  repository: string
  issueNumber: number
  title: string
  body: string
}): string {
  const body = issue.body.trim() === '' ? '(the issue has no description)' : issue.body
  return `Issue ${issue.repository}#${issue.issueNumber}: ${issue.title}\n\n<issue-body>\n${body.slice(0, BODY_MAX)}\n</issue-body>`
}

/** The verdict recorded for an issue's current body, and the question asked on it, if one was. */
export type RecordedReadiness = {
  verdict: ReadinessVerdict
  questionId?: number
  blockedBy?: string[]
  reason?: string
  /** The acceptance criteria drafted for this verdict; empty when the drafter had none or its answer was unreadable. */
  draft?: string[]
}

/**
 * What a pass does with a queued issue: judge it when no verdict is recorded for its current body; in `auto`,
 * hold back a blocked one that waits for issues a pass can read again (`block`: it goes where a blocked task
 * goes, and `retry-due` runs it once they close), and ask the owner when the verdict needs refinement or the
 * blocker cannot be read again and no question was asked yet; nothing otherwise, and nothing in `trial`.
 */
export function readinessStep(
  recorded: RecordedReadiness | undefined,
  mode: 'trial' | 'auto',
): 'judge' | 'ask' | 'block' | 'none' {
  if (!recorded) return 'judge'
  if (mode !== 'auto' || recorded.verdict === 'ready' || recorded.questionId !== undefined) {
    return 'none'
  }
  return recorded.verdict === 'blocked' && (recorded.blockedBy?.length ?? 0) > 0 ? 'block' : 'ask'
}

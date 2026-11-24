import { createHash } from 'node:crypto'

import { z } from 'zod'

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
})

export type Readiness = {
  verdict: ReadinessVerdict
  missing: string
  question: string
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
    if (missing.trim() === '') return unreadable('a blocked answer must name what is missing')
    const named = missing.trim()
    const asked =
      question.trim() ||
      `This issue cannot be built yet: ${named} Can it be unblocked, or should the issue change?`
    return { verdict, missing: named, question: asked }
  }
  return { verdict, missing: missing.trim(), question: question.trim() }
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
export type RecordedReadiness = { verdict: ReadinessVerdict; questionId?: number }

/**
 * What a pass does with a queued issue: judge it when no verdict is recorded for its current body, ask the
 * owner in `auto` when the verdict needs refinement and no question was asked for it yet (it may have been
 * judged in `trial`), and nothing otherwise.
 */
export function readinessStep(
  recorded: RecordedReadiness | undefined,
  mode: 'trial' | 'auto',
): 'judge' | 'ask' | 'none' {
  if (!recorded) return 'judge'
  const asks = mode === 'auto' && recorded.verdict !== 'ready' && recorded.questionId === undefined
  return asks ? 'ask' : 'none'
}

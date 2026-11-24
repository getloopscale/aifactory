import { z } from 'zod'

import { jsonObjects } from '../factory/review'

import type { Decision, RecordedAction } from './decide'
import type { TaskException } from './exceptions'
import { QUALITY_CONFIGURATION } from './scope'

/**
 * The unblocker without its side effects: the closed set of answers the agent may give, how its answer is
 * read, and what each one decides. It is the step between a decision that escalates and `apply.ts`: the model
 * proposes one action, this module checks it, and the action is applied through the panel's actions like any
 * other. An answer outside the set, or one that does not parse, is an `escalate` with the error.
 */

/** What only the owner can settle: an `escalate` of the unblocker must name one. */
export const OWNER_CATEGORIES = [
  'credentials',
  'repository_settings',
  'agent_configuration',
  'product_decision',
  'spending',
] as const

/** What the unblocker may do about a question of the builder that waits. */
const QUESTION_ACTIONS: UnblockAnswer['action'][] = ['answer', 'escalate']

/** The most unblocker actions applied on one task and head; the next one is an `escalate`. */
export const MAX_UNBLOCKER_APPLIED = 3

const text = z.string().trim().min(1)

export const unblockSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('answer'), text, reason: text }),
  z.object({
    action: z.literal('send_back'),
    note: text,
    files: z.array(text).default([]),
    output: z.string().trim().default(''),
    step: z.string().trim().default(''),
    reason: text,
  }),
  z.object({ action: z.literal('rerun_checks'), reason: text }),
  z.object({ action: z.literal('merge_base'), reason: text }),
  z.object({ action: z.literal('blocked_by'), issue: z.number().int().positive(), reason: text }),
  z.object({ action: z.literal('retry'), reason: text }),
  z.object({ action: z.literal('scope'), reason: text }),
  z.object({
    action: z.literal('resolve_elsewhere'),
    evidence: z.object({ commit: text.optional(), run: text.optional() }),
    reason: text,
  }),
  z.object({
    action: z.literal('escalate'),
    category: z.enum(OWNER_CATEGORIES),
    reason: text,
  }),
])

export type UnblockAnswer = z.infer<typeof unblockSchema>

export type ParsedUnblock = { ok: true; answer: UnblockAnswer } | { ok: false; error: string }

function parseCandidate(candidate: string): ParsedUnblock {
  let value: unknown
  try {
    value = JSON.parse(candidate)
  } catch (error) {
    return { ok: false, error: `the answer is not JSON: ${(error as Error).message}` }
  }
  const parsed = unblockSchema.safeParse(value)
  if (parsed.success) return { ok: true, answer: parsed.data }
  const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'action'}: ${i.message}`)
  return { ok: false, error: `the answer is not an unblocker action: ${issues.join('; ')}` }
}

/** Reads the answer as an action: the last object in it that is one, else the error of its longest object. */
export function parseUnblock(answer: string): ParsedUnblock {
  const candidates = jsonObjects(answer)
  if (candidates.length === 0) return { ok: false, error: 'the answer holds no JSON object' }
  const parsed = candidates.map(parseCandidate)
  const found = [...parsed].reverse().find((p) => p.ok)
  if (found) return found
  const longest = candidates.reduce((a, b) => (b.length > a.length ? b : a))
  return parsed[candidates.indexOf(longest)]
}

/** The unblocker actions already applied on this task and head. */
export const unblockerApplied = (recorded: RecordedAction[], head: string) =>
  recorded.filter((r) => r.by === 'unblocker' && r.outcome === 'applied' && r.headSha === head)

const escalated = (reason: string, answer?: string): Decision => ({
  action: 'escalate',
  reason,
  by: 'unblocker',
  ...(answer === undefined ? {} : { answer }),
})

/** The first quality configuration a text names, or nothing: no gate is loosened to get a task moving. */
const qualityNamed = (...parts: string[]) => {
  const told = parts.join('\n').toLowerCase()
  return QUALITY_CONFIGURATION.find((name) => told.includes(name))
}

/** What the builder is told when the unblocker sends the task back: the note, the files, the output and the step. */
function sendBackNote(a: Extract<UnblockAnswer, { action: 'send_back' }>): string {
  const parts = [`The coordinator sent this back after investigating it: ${a.note}`]
  if (a.step) parts.push(`Step: ${a.step}`)
  if (a.files.length > 0) parts.push(`Files:\n${a.files.map((f) => `- ${f}`).join('\n')}`)
  if (a.output) parts.push(`What failed:\n${a.output}`)
  return parts.join('\n\n')
}

/**
 * What the decision that escalated becomes, given the unblocker's answer: one action of the closed set, or
 * the same escalation with what the unblocker found. A `retry` needs a finding to retry from; an `answer` is
 * only for a question of the builder.
 */
export function unblockDecision(
  exception: TaskException,
  escalation: Decision,
  parsed: ParsedUnblock,
  recorded: RecordedAction[],
  raw: string,
): Decision {
  const by = 'unblocker' as const
  if (!parsed.ok) {
    return escalated(
      `${escalation.reason}. The unblocker's answer could not be used: ${parsed.error}`,
      raw,
    )
  }
  const a = parsed.answer
  const applied = unblockerApplied(recorded, exception.head)
  if (a.action !== 'escalate' && applied.length >= MAX_UNBLOCKER_APPLIED) {
    return escalated(
      `${escalation.reason}. The unblocker already applied ${applied.length} actions on ${exception.head.slice(0, 7)}: a person decides what comes next`,
    )
  }
  const why = `${escalation.reason}. The unblocker investigated: ${a.reason}`
  // A question of the builder is answered, blocked or left to the owner: the task is not in a stage to be sent back.
  if (exception.kind === 'builder_question' && !QUESTION_ACTIONS.includes(a.action)) {
    return escalated(
      `${why}. It proposed ${a.action}, which does not answer a question of the builder`,
    )
  }
  switch (a.action) {
    case 'escalate':
      return escalated(`${escalation.reason}. For the owner (${a.category}): ${a.reason}`)
    case 'send_back': {
      const named = qualityNamed(a.note, a.output, a.step, ...a.files)
      if (named) {
        return escalated(
          `${why}. Its note names ${named}, and no quality gate is loosened to get a task moving`,
        )
      }
      return { action: 'send_back', by, reason: why, note: sendBackNote(a) }
    }
    case 'rerun_checks':
      return { action: 'rerun_checks', by, reason: why }
    case 'merge_base':
      return {
        action: 'merge_base',
        by,
        reason: why,
        note: `The coordinator merges the integration branch into this branch after investigating it: ${a.reason}`,
      }
    case 'scope':
      return { action: 'scope', by, reason: why }
    case 'retry':
      return exception.findingId === undefined
        ? escalated(`${why}. It asked for a retry, but no finding names the step to retry from`)
        : { action: 'retry_from_finding', by, findingId: exception.findingId, reason: why }
    case 'resolve_elsewhere':
      return a.evidence.commit || a.evidence.run
        ? { action: 'resolve_elsewhere', by, reason: why, evidenceFor: a.evidence }
        : escalated(
            `${escalation.reason}. The unblocker said the work is resolved elsewhere, with no commit or passing run as evidence`,
          )
    case 'answer':
      return exception.kind === 'builder_question'
        ? { action: 'answer', by, reason: why, answerText: a.text }
        : escalated(`${why}. It proposed an answer, but no question of the builder waits here`)
    case 'blocked_by':
      return { action: 'blocked_by', by, reason: why, blockedBy: a.issue }
  }
}

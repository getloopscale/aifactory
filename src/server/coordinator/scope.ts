import { z } from 'zod'

import { blockingCount, jsonObjects, renderFindings, type Finding } from '../factory/review'

/**
 * The `scope` action without its side effects: what the drafter is given, how its answer is read, what is
 * refused in it, and the text written to GitHub. Everything here is pure; `draft.ts` calls the model and
 * `apply.ts` writes.
 */

const text = z.string().trim().min(1)

/** What the drafter answers: the requests that belong to the issue, the rest, a follow-up and the note. */
export const scopeDraftSchema = z.object({
  inScope: z.array(text),
  outOfScope: z.array(text),
  followUp: z.object({ title: text, body: text }).nullable(),
  note: text,
  /**
   * Set only when every blocking finding asks for an issue the builder cannot file: the framework gap the
   * factory files itself, in `repository` (`owner/name`, named in the findings or the issue).
   */
  gap: z
    .object({
      repository: z
        .string()
        .trim()
        .regex(/^[\w.-]+\/[\w.-]+$/),
      title: text,
      body: text,
    })
    .nullish(),
})

export type ScopeDraft = z.infer<typeof scopeDraftSchema>

export type ParsedDraft = { ok: true; draft: ScopeDraft } | { ok: false; error: string }

/**
 * Reads the drafter's answer as a draft: the last object in it that is one. When none is, the error is the
 * one of its longest object, the one the drafter most likely meant.
 */
export function parseScopeDraft(answer: string): ParsedDraft {
  const candidates = jsonObjects(answer)
  if (candidates.length === 0) return { ok: false, error: 'the answer holds no JSON object' }
  const parsed = candidates.map(parseCandidate)
  const draft = [...parsed].reverse().find((p) => p.ok)
  if (draft) return draft
  const longest = candidates.reduce((a, b) => (b.length > a.length ? b : a))
  return parsed[candidates.indexOf(longest)]
}

function parseCandidate(candidate: string): ParsedDraft {
  let value: unknown
  try {
    value = JSON.parse(candidate)
  } catch (error) {
    return { ok: false, error: `the answer is not JSON: ${(error as Error).message}` }
  }
  const parsed = scopeDraftSchema.safeParse(value)
  if (parsed.success) return { ok: true, draft: parsed.data }
  const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
  return { ok: false, error: `the answer is not a scope draft: ${issues.join('; ')}` }
}

/**
 * Names of the quality configuration a scope decision may never ask the builder to touch. A draft whose
 * note or in-scope requests name one is refused: no gate is loosened to make a review converge.
 */
export const QUALITY_CONFIGURATION = [
  'quality/',
  'stryker',
  '.jscpd',
  'crap-baseline',
  'coverage threshold',
] as const

/** The first quality configuration the builder would be told to touch, or nothing. */
export function qualityConfigurationNamed(draft: ScopeDraft): string | undefined {
  const told = [draft.note, ...draft.inScope].join('\n').toLowerCase()
  return QUALITY_CONFIGURATION.find((name) => told.includes(name))
}

/**
 * Work a scope decision may not put in scope, since the factory cannot do it from its sandbox: `diffGuards` refuses a
 * change under `.github/`, nothing there publishes a package, and its token cannot edit an issue or a pull request.
 * Each is named as the refusal says it.
 */
const INFEASIBLE: [string, RegExp[]][] = [
  ['a change under .github/', [/\.github\//]],
  [
    'publishing a package',
    [/\b(npm|pnpm|yarn) publish\b/, /\bpublish(es|ing)?\b[^.]*\b(package|npm|registry)\b/],
  ],
  [
    'editing an issue or a pull request on GitHub',
    [
      /\bon github\b/,
      /\b(issue|pull request|pr)('s)? (body|title|description)\b/,
      /\b(body|title|description) of (the )?(issue|pull request|pr)\b/,
      /#\d+('s)? (body|title|description)\b/,
    ],
  ],
]

/** The first work in scope the factory cannot do, or nothing. */
export function infeasibleNamed(draft: ScopeDraft): string | undefined {
  const told = draft.inScope.map((item) => item.toLowerCase().replace(/\s+/g, ' '))
  return INFEASIBLE.find(([, patterns]) =>
    told.some((item) => patterns.some((pattern) => pattern.test(item))),
  )?.[0]
}

const list = (items: string[]) =>
  (items.length > 0 ? items : ['nothing']).map((item) => `- ${item}`).join('\n')

/** The section appended to the issue body, naming the follow-up when one was filed. */
export function scopeSection(draft: ScopeDraft, date: string, followUp: number | undefined) {
  return [
    `## Scope decision (${date})`,
    '',
    'The review of this issue did not converge, so the coordinator decided which requests belong to it.',
    '',
    'In scope:',
    '',
    list(draft.inScope),
    '',
    followUp === undefined ? 'Out of scope:' : `Out of scope, filed as #${followUp}:`,
    '',
    list(draft.outOfScope),
  ].join('\n')
}

const FOLLOW_UP_OF = 'Follow-up of'

/** The follow-up issue the draft files, its body ending with a line linking the original issue. */
export function followUpIssue(draft: ScopeDraft, repo: string, issueNumber: number) {
  if (!draft.followUp) return undefined
  return {
    title: draft.followUp.title,
    body: `${draft.followUp.body}\n\n${FOLLOW_UP_OF} ${repo}#${issueNumber}.`,
  }
}

const ORIGIN = new RegExp(`^${FOLLOW_UP_OF} ([\\w.-]+/[\\w.-]+)#(\\d+)\\.$`, 'm')

/** The issue a follow-up was filed for, read from the line `followUpIssue` ends its body with; nothing for any other issue. */
export function followUpOrigin(body: string): { repo: string; issue: number } | undefined {
  const found = ORIGIN.exec(body)
  return found ? { repo: found[1], issue: Number(found[2]) } : undefined
}

/** A title as two people would write it: its case, spacing and punctuation set aside. */
const normalised = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/**
 * Whether an open issue already is the follow-up `title` would file for `repo#issueNumber`: a follow-up of the same
 * issue, or an issue with the same title.
 */
export function sameFollowUp(
  open: { title: string; body: string },
  repo: string,
  issueNumber: number,
  title: string,
): boolean {
  const origin = followUpOrigin(open.body)
  if (origin?.repo === repo && origin.issue === issueNumber) return true
  return normalised(open.title) === normalised(title)
}

/** One review round of the task, as the `review` table holds it. */
export type ReviewRound = {
  round: number
  sha: string
  verdict: 'approve' | 'changes' | 'invalid'
  summary: string
  findings: Finding[]
}

/**
 * The rounds of the run that handed over: its last review for each attempt, oldest first, with the
 * blocking findings of each, which is what `roundsNote` counts.
 */
export function roundsOfRun(reviews: ReviewRound[], attempts: number) {
  const ofRun = attempts > 0 ? reviews.slice(-attempts) : []
  return { reviews: ofRun, counts: ofRun.map((r) => blockingCount(r.findings)) }
}

/** What the drafter reads: the issue, the plan, every round of the review and what the last one asked. */
export type ScopeInput = {
  repo: string
  issueNumber: number
  title: string
  body: string
  /** The task's plan as markdown, when it has one. */
  plan: string | undefined
  reviews: ReviewRound[]
  /** What the reviewer still asked for when the run handed over. */
  findings: Finding[]
  roundsNote: string
}

const BODY_MAX = 12_000
const PLAN_MAX = 6_000
const ROUND_MAX = 2_500

const round = (r: ReviewRound) =>
  `Round ${r.round} on ${r.sha.slice(0, 7)} (${r.verdict}): ${r.summary}\n${renderFindings(r.findings)}`.slice(
    0,
    ROUND_MAX,
  )

/** The message the drafter gets. The issue and the plan sit inside markers, as data. */
export function scopeMessage(input: ScopeInput): string {
  return [
    `Issue ${input.repo}#${input.issueNumber}: ${input.title}`,
    '',
    `<issue-body>\n${input.body.slice(0, BODY_MAX)}\n</issue-body>`,
    '',
    `<plan>\n${(input.plan ?? 'The task has no stored plan.').slice(0, PLAN_MAX)}\n</plan>`,
    '',
    `<review-rounds>\n${input.reviews.map(round).join('\n\n')}\n</review-rounds>`,
    '',
    `<last-findings>\n${renderFindings(input.findings).slice(0, ROUND_MAX)}\n</last-findings>`,
    '',
    `Rounds: ${input.roundsNote.trim() || 'no count of the rounds was kept'}`,
  ].join('\n')
}

/** The gap issue a draft asks the factory to file, or nothing for an ordinary scope. */
export function gapIssue(draft: ScopeDraft, repo: string, issueNumber: number) {
  if (!draft.gap) return undefined
  return {
    repository: draft.gap.repository,
    title: draft.gap.title,
    body: `${draft.gap.body}\n\nFiled by the factory for ${repo}#${issueNumber}, whose review asked for this issue.`,
  }
}

/** Whether an open issue is the gap issue `title` would file: the same title, as two people would write it. */
export function sameGap(open: { title: string }, title: string): boolean {
  return normalised(open.title) === normalised(title)
}

/** The send-back note of a gap: the drafter's note, then the issue the builder is to link. */
export function gapNote(draft: ScopeDraft, reference: string): string {
  return `${draft.note}\n\nThe framework gap issue is ${reference}. Link it in the done-when and say no more about filing it: the factory filed it, and the sandbox cannot.`
}

/** Whether the target of a gap is named in what the drafter read: the issue and the review, never a guess. */
export function gapTargetNamed(draft: ScopeDraft, message: string): boolean {
  return !draft.gap || message.toLowerCase().includes(draft.gap.repository.toLowerCase())
}

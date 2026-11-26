import { buildPrompt } from './harness'
import { jsonObjects } from './review'

/**
 * What the builder means to do before it does it: the files it will change and why, the order, the risks,
 * the tests that prove it, and what it leaves out. It is stored, shown in the pull request and the panel,
 * and given to the reviewer, who measures the diff against it.
 */
export type Acceptance = { id: string; statement: string; evidence: string }

export type ChangePlan = {
  /** What the finished work must do, one behaviour each. A plan stored before ADR 0009's 2026-11-25 note has none. */
  acceptance?: Acceptance[]
  files: { path: string; why: string }[]
  order: string[]
  risks: string[]
  proof: string[]
  outOfScope: string[]
}

const MAX_FILES = 200
const MAX_ITEMS = 30
const TEXT_MAX = 500

/** The turn before any change: the issue and the rules of a build, then the plan in place of the work. */
export function changePlanPrompt(input: Parameters<typeof buildPrompt>[0]): string {
  return `${buildPrompt(input, 'planner')}
# This turn: plan only

Do this in two turns. In this one, read the code and plan; you will be told to implement the plan in the next.
- Do not create, edit or delete any file, and do not run anything that writes to the repository. You may read files and run read-only commands.
- Do not ask a question in this turn. Write what is undecided under "risks", with the option you would take; you may ask in the next turn.
- Start from the issue: state, one by one, what the finished work does, as "acceptance". Each entry has an id ("A1", "A2", ...), a statement of one behaviour, and the evidence that shows it: a test by name, a check, or a file and symbol. The reviewer holds the work against this list, so it must not be empty.
- Name every file you expect to change, the tests included. A folder ending in "/" or a pattern with "*" may stand for several files.

Finish with one JSON object on its own, and nothing after it:

{"acceptance":[{"id":"A1","statement":"one behaviour the finished work has","evidence":"the test, check, or file and symbol that shows it"}],"files":[{"path":"path/from/the/repository/root","why":"what changes there"}],"order":["first step","..."],"risks":["what could break, or what is undecided"],"proof":["the test or command that shows it works"],"outOfScope":["what the issue might suggest that you will not do"]}
`
}

/** When the planning turn ended without a plan that could be read. */
export function planAgainPrompt(): string {
  return 'Your answer had no plan that could be read. Do not change any file. Answer with the plan only, as one JSON object with "acceptance" (a list that is not empty), "files", "order", "risks", "proof" and "outOfScope", and nothing after it.'
}

/**
 * The builder's first turn when another agent wrote the plan: the issue and the rules of a build, then the plan,
 * named by who wrote it. The builder works in a session of its own, so the plan is all it knows of that reading.
 */
export function givenPlanPrompt(
  input: Parameters<typeof buildPrompt>[0],
  plan: ChangePlan,
  planner: string,
): string {
  return `${buildPrompt(input)}
# The plan

Before you, ${planner} read the code and wrote this plan:

${renderChangePlan(plan)}

Implement it, following the rules above.
- Hold to the files the plan names. If the work needs a file the plan does not name, change it and say why in your final summary: a reviewer compares the diff with the plan, and a file outside it with no reason is sent back.
- When the code shows the plan is wrong about something (a file, a function or a behaviour that is not there), do what the issue needs and say in your final summary where you left the plan and why.
- Finish with a short summary of what you changed.
`
}

/** The turn that does the work, in the session that wrote the plan. */
export function implementPlanPrompt(input: { discarded: boolean }): string {
  return [
    'Implement the plan you wrote, following the rules you were given.',
    ...(input.discarded
      ? [
          'The planning turn was not to change files, so what you changed in it was discarded: the checkout is as it was.',
        ]
      : []),
    'Hold to the files the plan names. If the work needs a file the plan does not name, change it and say why in your final summary: a reviewer compares the diff with the plan, and a file outside it with no reason is sent back.',
    'Finish with a short summary of what you changed.',
  ].join('\n\n')
}

function texts(value: unknown, max = MAX_ITEMS): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    .slice(0, max)
    .map((item) => item.slice(0, TEXT_MAX))
}

const MAX_ACCEPTANCE = 30

function acceptanceOf(value: unknown): Acceptance[] {
  if (!Array.isArray(value)) return []
  const entries: Acceptance[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const { id, statement, evidence } = entry as Record<string, unknown>
    if (typeof id !== 'string' || id.trim() === '') continue
    if (typeof statement !== 'string' || statement.trim() === '') continue
    entries.push({
      id: id.trim().slice(0, 20),
      statement: statement.trim().slice(0, TEXT_MAX),
      evidence: typeof evidence === 'string' ? evidence.trim().slice(0, TEXT_MAX) : '',
    })
  }
  return entries.slice(0, MAX_ACCEPTANCE)
}

/** A plan from a planning turn: one that lists no acceptance is read as no plan, so the turn is asked again. */
export function parseNewChangePlan(text: string): ChangePlan | undefined {
  const plan = parseChangePlan(text)
  return plan && (plan.acceptance?.length ?? 0) > 0 ? plan : undefined
}

/** A path inside the repository: relative, and never climbing out of it. */
function insideRepository(path: string): boolean {
  return path !== '' && !path.startsWith('/') && !path.split('/').includes('..')
}

function filesOf(value: unknown[]): ChangePlan['files'] {
  return value
    .map((entry) =>
      typeof entry === 'string'
        ? { path: entry, why: '' }
        : typeof entry === 'object' &&
            entry !== null &&
            typeof (entry as { path?: unknown }).path === 'string'
          ? {
              path: (entry as { path: string }).path,
              why: String((entry as { why?: unknown }).why ?? '').slice(0, TEXT_MAX),
            }
          : undefined,
    )
    .filter(
      (file): file is { path: string; why: string } =>
        file !== undefined && insideRepository(file.path),
    )
    .slice(0, MAX_FILES)
}

/** The last JSON object in the answer that has a list of files, or nothing when there is none. */
export function parseChangePlan(text: string): ChangePlan | undefined {
  for (const candidate of jsonObjects(text).reverse()) {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(candidate) as Record<string, unknown>
    } catch {
      continue
    }
    if (!Array.isArray(parsed.files)) continue
    return {
      acceptance: acceptanceOf(parsed.acceptance),
      files: filesOf(parsed.files),
      order: texts(parsed.order),
      risks: texts(parsed.risks),
      proof: texts(parsed.proof),
      outOfScope: texts(parsed.outOfScope),
    }
  }
  return undefined
}

/** Files that change because their manifest did: nobody plans them one by one. */
export const LOCKFILE =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|go\.sum|Cargo\.lock|uv\.lock|poetry\.lock)$/

/** A planned path as a test: a folder ending in "/", `*` within a folder, `**` at any depth. */
function matcher(planned: string): (path: string) => boolean {
  if (planned.endsWith('/')) return (path) => path.startsWith(planned)
  const source = planned
    .split('**')
    .map((part) =>
      part
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*'),
    )
    .join('.*')
  const pattern = new RegExp(`^${source}$`)
  return (path) => pattern.test(path)
}

/** The changed files the plan does not cover, lockfiles left out. */
export function unplannedFiles(changed: string[], plan: ChangePlan): string[] {
  const covers = plan.files.map((f) => matcher(f.path))
  return changed.filter((path) => !LOCKFILE.test(path) && !covers.some((test) => test(path)))
}

function list(title: string, items: string[], numbered = false): string[] {
  if (items.length === 0) return []
  return [
    '',
    `**${title}**`,
    '',
    ...items.map((item, i) => `${numbered ? `${i + 1}.` : '-'} ${item}`),
  ]
}

/** The plan as markdown, for the pull request, the reviewer and the panel. */
export function renderChangePlan(plan: ChangePlan): string {
  const files =
    plan.files.length === 0
      ? ['No file: the builder expected the code to already do what the issue asks.']
      : plan.files.map((f) => `- \`${f.path}\`${f.why ? `: ${f.why}` : ''}`)
  const acceptance = (plan.acceptance ?? []).map(
    (a) => `- **${a.id}**: ${a.statement}${a.evidence ? ` (evidence: ${a.evidence})` : ''}`,
  )
  return [
    ...(acceptance.length > 0 ? ['**Acceptance**', '', ...acceptance, ''] : []),
    '**Files**',
    '',
    ...files,
    ...list('Order', plan.order, true),
    ...list('Risks', plan.risks),
    ...list('Proof', plan.proof),
    ...list('Out of scope', plan.outOfScope),
  ].join('\n')
}

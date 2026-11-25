import type { SandboxBackend } from '@theokit/agents/sandbox'

import { modeFromEnv, type CoordinatorMode } from '../coordinator/mode'
import { knowledgeRules } from '../knowledge/prompt'

import { issueRef } from './item-ref'
import { parseVerdict, type Finding, type ReviewVerdict } from './review'
import { must } from './run-support'
import { findingKey } from './security-review'

/**
 * The read-only lenses over approved work (#548): one more review of the same change, each with one question the
 * code review is not asked. A lens is an entry of `LENSES`; the run (`Run.lensed`) and the evaluation's run
 * (`evals/run-case.ts`) share the prompt, the reading of the answer and the decision that live here.
 */

/** The lens reviews that may send work back to the builder, so a change cannot loop between them. */
export const MAX_LENS_REWORKS = 1

/** How far a lens goes: `off` runs none, `trial` (the default) records and sends nothing back, `auto` sends back once. */
export type LensMode = CoordinatorMode

export const lensModeFromEnv = (env: NodeJS.ProcessEnv): LensMode =>
  modeFromEnv(env, 'FACTORY_LENS_MODE')

export type LensName = 'docs'

export type LensInput = {
  repo: string
  issueNumber: number
  title: string
  body: string
  baseSha: string
  diff: string
  /** The paths of the repository's documents, which the lens may open. */
  documents: string[]
  knowledgeDir?: string
  /** What an earlier round of this lens found, which this one checks first. */
  earlier?: Finding[]
}

export type Lens = {
  name: LensName
  /** Whether a path is one the lens cares about. */
  cares: (path: string) => boolean
  prompt: (input: LensInput) => string
}

/** The repository's documents: `README*`, `AGENTS.md`, `CLAUDE.md`, `CHANGELOG.md` and `docs/**`. */
const DOCUMENT = /^(?:(?:.*\/)?README(?:\.[^/]*)?|AGENTS\.md|CLAUDE\.md|CHANGELOG\.md|docs\/.*)$/

export const isDocument = (path: string): boolean => DOCUMENT.test(path)

const MAX_DOCUMENTS = 200

function docsPrompt(input: LensInput): string {
  const earlier = (input.earlier ?? []).filter((f) => f.severity !== 'minor')
  const documents =
    input.documents.length > 0
      ? input.documents.map((p) => `- ${p}`).join('\n')
      : '(the repository has no document)'
  return `You are an independent documentation reviewer for the repository ${input.repo}. Another agent implemented the issue below, and a code reviewer approved it. You did not write this code and you must not change it.

# ${input.title} (${issueRef(input.issueNumber)})

${input.body || '(the issue has no description)'}

The change is below (the same as \`git diff ${input.baseSha}...HEAD\`).

<change>
${input.diff}
</change>

The repository's documents are:

${documents}

Open the documents the change could make false, and search for the names it changes. Report only:
- A statement in a document that this change makes false (a path, a command, a count, a name, a behaviour, a status).
- A file, command or symbol this change adds that an index in a document lists its siblings of, and that the index leaves out.
Do not report style, wording, formatting, spelling or a document that was already wrong before the change. Do not report what the change merely does not document.
You may read files and search. Do not edit, create or delete files, do not run any command that writes, and do not run the project.
${input.knowledgeDir ? `\n${knowledgeRules(input.knowledgeDir)}\n` : ''}${
    earlier.length > 0
      ? `\nAn earlier round found the following. Check each first and say whether the change resolves it:\n${earlier.map((f) => `- ${f.file ?? '(no file)'}: ${f.issue}`).join('\n')}\n`
      : ''
  }
Each finding names the document as its file and says which statement is false and what it should say.

Finish with one JSON object on its own, and nothing after it:

{"verdict":"approve"|"changes","summary":"one or two sentences","findings":[{"severity":"blocker"|"major"|"minor","file":"path or omit","issue":"what is wrong and what to do"}]}

Use "changes" when there is any blocker or major finding. Use "approve" when no document is left false.
`
}

/** The closed list of lenses; another lens is another entry. */
export const LENSES: readonly Lens[] = [{ name: 'docs', cares: isDocument, prompt: docsPrompt }]

/** The name a lens's review is stored under: the review table has no lens column. */
export const lensReviewer = (lens: LensName, reviewer: string): string =>
  `${LENS_PREFIX}${lens} (${reviewer})`

export const LENS_PREFIX = 'lens:'

export const isLensReviewer = (reviewer: string): boolean => reviewer.startsWith(LENS_PREFIX)

/** The tracked documents of the checkout, sorted, with the names git quotes read as they are. */
export async function documentPaths(backend: SandboxBackend, repoDir: string): Promise<string[]> {
  const listed = await must(backend, `git -C ${repoDir} ls-files -z`)
  return listed.stdout
    .split('\0')
    .filter((p) => p !== '' && isDocument(p))
    .sort()
    .slice(0, MAX_DOCUMENTS)
}

/** A lens's answer, read as a review's: an answer that is not one is `invalid`. */
export const parseLensVerdict = (answer: string): ReviewVerdict =>
  parseVerdict(answer, { followUpPaths: false })

export type LensOutcome =
  /** Nothing blocks, or the answer was unusable: the work goes on. */
  | { kind: 'pass' }
  /** The builder is asked once. */
  | { kind: 'rework'; findings: Finding[] }
  /** The blocking findings go on the pull request as notes. */
  | { kind: 'note'; findings: Finding[] }

/** What a lens round ends in. It never hands over and never fails: the most it does is send back once. Reads nothing. */
export function decideLens(input: {
  mode: LensMode
  verdict: ReviewVerdict
  reworks: number
  canRework: boolean
}): LensOutcome {
  const { mode, verdict, reworks, canRework } = input
  // In `trial` the review is recorded and nothing else changes.
  if (mode !== 'auto' || verdict.verdict === 'invalid') return { kind: 'pass' }
  const found = verdict.findings.filter((f) => f.severity !== 'minor')
  if (found.length === 0) return { kind: 'pass' }
  if (canRework && reworks < MAX_LENS_REWORKS) {
    return { kind: 'rework', findings: found }
  }
  return { kind: 'note', findings: found }
}

/** The findings of a lens that the pull request keeps as notes, one per finding the earlier rounds did not repeat. */
export function noteFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>()
  return findings.filter((f) => {
    const key = findingKey(f)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

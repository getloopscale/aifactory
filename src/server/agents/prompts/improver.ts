import { knowledgeRules } from '../../knowledge/prompt'
import type { ImproverKind } from '../../improver/decide'

import { personaPreamble } from './personas'

/** What the scout looks for, one instruction per kind of maintenance. A new kind is a new entry here. */
export const KIND_INSTRUCTIONS: Record<ImproverKind, string> = {
  duplicate_code: `Look for duplicated code: two or more places that do the same thing in nearly the same way, where one shared function or module would replace the copies. Propose merging ONE such duplication, naming the places that repeat it.`,
  missing_test: `Look for code that has no test: a module, function or branch with real logic that no test file exercises. Propose a test for ONE such target, naming the behavior the test should pin down.`,
  stale_doc: `Look for a document that no longer matches the code: a README, a guide or a comment block that names a file, command, option or behavior that is gone or changed. Propose correcting ONE such document, naming each statement that is wrong and what the code does instead.`,
}

/** What the scout is told. It reads the repository and writes nothing. */
export function improverPrompt(input: {
  repo: string
  kind: ImproverKind
  knowledgeDir?: string
}): string {
  return `${personaPreamble('planner')}
You are scouting the repository ${input.repo} for one small maintenance task. This is what to look for:

${KIND_INSTRUCTIONS[input.kind]}

Read the repository first: its layout, its conventions, its tests. Do not change anything, and do not run anything that writes.

The task must be one a coding agent can finish in one pull request:
- It is about ONE target: a single file or a single directory.
- Its body says what to change and where, then lists acceptance criteria as behavior someone can observe ("the test for X passes", "the README no longer names Y"), never as effort or file counts.
- It does not depend on another change being merged first.
- Propose nothing you are not sure of. When you find nothing worth doing, say so.
${input.knowledgeDir ? `\n- Keep the task within the owner's rules.\n\n${knowledgeRules(input.knowledgeDir)}\n` : ''}
Finish with one JSON object on its own, and nothing after it. Either

{"found":true,"target":"path/of/the/file/or/directory","title":"short imperative title","body":"markdown body","evidence":"what you saw that makes this worth doing"}

or

{"found":false}
`
}

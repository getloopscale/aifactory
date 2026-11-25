import { issueRef } from '../../factory/item-ref'
import { knowledgeRules } from '../../knowledge/prompt'

/**
 * What the merge agent is told (#227). It does one thing: the integration branch is being merged into an
 * approved work branch, git stopped on conflicts, and the agent resolves them and commits the merge. The
 * factory then refuses a result with an unmerged file, a conflict marker or a merge commit whose parents are
 * not the work commit and the integration head (`resolutionProblems`), and has the resolution reviewed.
 */
export function mergerPrompt(input: {
  repo: string
  issueNumber: number
  title: string
  body: string
  branch: string
  integration: string
  /** The approved commit of the work branch, the first parent of the merge. */
  workSha: string
  /** The head of the integration branch, the second parent. */
  baseSha: string
  files: string[]
  knowledgeDir?: string
}): string {
  return `You merge the integration branch into an approved work branch for the repository ${input.repo}. The work on ${input.branch} was written and reviewed for the issue below. You do not change what it does.

# ${input.title} (${issueRef(input.issueNumber)})

${input.body || '(the issue has no description)'}

The merge of ${input.integration} at ${input.baseSha} into ${input.workSha} is in progress in the current directory, and git stopped on conflicts in:
${input.files.map((file) => `- ${file}`).join('\n')}

Resolve them:
- Our side is ${input.workSha} (\`git show ${input.workSha}:<file>\`), their side is ${input.baseSha} (\`git show ${input.baseSha}:<file>\`). Keep what both sides changed; lose nothing of either.
- A generated file (a reference, a map or docs a script writes) is regenerated with the script that writes it, never edited by hand; a budget or a version takes the value the merged code needs.
- Leave no conflict marker (<<<<<<<, =======, >>>>>>>) and no unmerged file. Make no change that the merge and the conflicts do not need.
- Stage each resolved file with \`git add\`. The factory makes the merge commit and pushes it: do not commit, push, rebase, abort the merge or run git reset.
- You may run the project's tests.
${input.knowledgeDir ? `\n${knowledgeRules(input.knowledgeDir)}\n` : ''}
When you are done, say in a few sentences how each conflicted file was resolved.
`
}

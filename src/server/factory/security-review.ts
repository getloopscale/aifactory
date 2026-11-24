import { knowledgeRules } from '../knowledge/prompt'

import { parseVerdict, type Finding, type ReviewVerdict } from './review'

/**
 * The read-only security review of approved work (#241, #457): one agent at the highest effort its engine
 * offers reads the change and answers with the shape of a review. The prompt, the reading of its answer and the
 * identity of a finding live here so the factory's run and the evaluation's run (`evals/run-case.ts`) share them.
 */

/** The security reviews that may send work back to the builder, so a change cannot loop between the two. */
export const MAX_SECURITY_REWORKS = 2

export function securityPrompt(input: {
  repo: string
  issueNumber: number
  title: string
  body: string
  baseSha: string
  /** The files and the patch of the change, so the agent reads it instead of exploring (`securityDiff`). */
  diff?: string
  knowledgeDir?: string
  /** What an earlier security round found on this task, which this one checks first. */
  earlier?: Finding[]
}): string {
  const earlier = (input.earlier ?? []).filter((f) => f.severity !== 'minor')
  return `You are an independent security reviewer for the repository ${input.repo}. Another agent implemented the issue below, and a code reviewer approved it. You did not write this code and you must not change it.

# ${input.title} (#${input.issueNumber})

${input.body || '(the issue has no description)'}

${
  input.diff
    ? `The change is below (the same as \`git diff ${input.baseSha}...HEAD\`). Judge it from this text; open a file only to see context a finding needs, and do not explore the rest of the repository. Finish quickly.\n\n<change>\n${input.diff}\n</change>\n\n`
    : `Read the change with \`git diff ${input.baseSha}...HEAD\` and the files it touches. `
}Review it for security only:
- Secrets and credentials the change adds (keys, tokens, passwords, private keys), in any file, including tests and examples.
- Dependencies it adds or upgrades: a version with a known advisory, an unpinned or unusual source, a lifecycle script.
- Injection: SQL, shell, path, template or prompt built from input that an outsider controls; unsafe deserialization; unvalidated redirects.
- Missing authorization or authentication on what the change exposes, and trust placed in input the boundary did not validate.
- Weakened cryptography, disabled certificate checks, widened CORS or permissions.
- Do not report style, naming or correctness that is not a security matter: the code reviewer did that.
- You may read files and search. Do not edit, create or delete files, do not run any command that writes, and do not run the project.
${input.knowledgeDir ? `\n${knowledgeRules(input.knowledgeDir)}\n` : ''}${
    earlier.length > 0
      ? `\nAn earlier round found the following. Check each first and say whether the change resolves it:\n${earlier.map((f) => `- ${f.file ?? '(no file)'}: ${f.issue}`).join('\n')}\n`
      : ''
  }
Name the class of each weakness and list every instance of it in the change, each with its file and line, as one finding. Never ask to ignore an advisory, lower a level or skip a check.

Finish with one JSON object on its own, and nothing after it:

{"verdict":"approve"|"changes","summary":"one or two sentences","findings":[{"severity":"blocker"|"major"|"minor","file":"path or omit","issue":"what is wrong and what to do"}]}

Use "changes" when there is any blocker or major finding. Use "approve" only when you would ship it as it is.
`
}

/** An agent's answer, read as a review's: an answer that is not one is `invalid`, which never approves. */
export const parseSecurityVerdict = (answer: string): ReviewVerdict =>
  parseVerdict(answer, { followUpPaths: false })

/**
 * What identifies a finding between rounds: the file and the words of the issue with digits and case folded
 * away, so a line number that moved does not make a repeated finding look new.
 */
export function findingKey(finding: Finding): string {
  const words = finding.issue
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/[^a-z#]+/g, ' ')
    .trim()
  return `${finding.file ?? ''}|${words.slice(0, 120)}`
}

/** The blocking findings of a round that an earlier round already named. */
export function repeatedFindings(seen: ReadonlySet<string>, findings: Finding[]): Finding[] {
  return findings.filter((f) => f.severity !== 'minor' && seen.has(findingKey(f)))
}

/** What a security round ends in: the work goes on, back to the builder, or to a person. */
export type SecurityOutcome =
  | { kind: 'pass' }
  | { kind: 'rework'; findings: Finding[] }
  | { kind: 'handoff'; reason: string; findings: Finding[] }

/**
 * Decides over a verdict. A floor finding or an unusable answer goes to a person; the first agent block goes back to
 * the builder; a finding already named, or a budget used up, goes to a person. Reads nothing.
 */
export function decideSecurity(input: {
  floor: Finding[]
  verdict: ReviewVerdict
  seen: ReadonlySet<string>
  reworks: number
  canRework: boolean
}): SecurityOutcome {
  const { floor, verdict, seen, reworks, canRework } = input
  const blocking = floor.filter((f) => f.severity !== 'minor')
  if (blocking.length > 0) {
    return {
      kind: 'handoff',
      reason: `the security check found ${blocking.length} blocking finding${blocking.length === 1 ? '' : 's'} no agent may waive`,
      findings: [...floor, ...verdict.findings],
    }
  }
  if (verdict.verdict === 'invalid') {
    return {
      kind: 'handoff',
      reason: `the security review gave no usable verdict: ${verdict.summary}`,
      findings: verdict.findings,
    }
  }
  const found = verdict.findings.filter((f) => f.severity !== 'minor')
  if (verdict.verdict === 'approve' && found.length === 0) return { kind: 'pass' }
  if (repeatedFindings(seen, verdict.findings).length > 0) {
    return {
      kind: 'handoff',
      reason: 'the security review found again what it had already sent back',
      findings: verdict.findings,
    }
  }
  if (!canRework || reworks >= MAX_SECURITY_REWORKS) {
    return {
      kind: 'handoff',
      reason: `the security review still blocks after ${reworks} send-back${reworks === 1 ? '' : 's'}`,
      findings: verdict.findings,
    }
  }
  return { kind: 'rework', findings: verdict.findings }
}

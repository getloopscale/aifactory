import { issueRef } from './item-ref'
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

# ${input.title} (${issueRef(input.issueNumber)})

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

const MANIFESTS =
  /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|pnpm-workspace\.yaml|\.npmrc|requirements[^/]*\.txt|Pipfile(\.lock)?|poetry\.lock|pyproject\.toml|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile(\.lock)?|composer\.(json|lock)|pom\.xml|build\.gradle(\.kts)?|Dockerfile[^/]*|\.env[^/]*)$/
const CI_FILES =
  /(^|\/)(\.github\/|\.gitlab-ci\.yml$|\.circleci\/|azure-pipelines\.yml$|Jenkinsfile$)/
const DOCS = /\.(md|mdx|txt|rst)$|(^|\/)docs\//i
const TESTS =
  /\.(test|spec|evals\.test)\.[cm]?[jt]sx?$|(^|\/)(__tests__|__mocks__|fixtures|tests?)\//

/** What the added lines of a source file say about the surface they touch, each with the name the stage records. */
const CODE_SURFACES: [string, RegExp][] = [
  [
    'secrets, tokens, auth, crypto or signatures',
    /secret|token|passw(or)?d|credential|api[_-]?key|private[_-]?key|\bauth\w*|\bjwt\b|bearer|cookie|session|\bcrypto\b|createHash|createHmac|\bhmac\b|signature|\bsign(ed)?\(|\bverify\(|\bcipher|\bencrypt|\bdecrypt|\bbcrypt|\bpbkdf|\bscrypt|randomBytes|timingSafeEqual|rejectUnauthorized|\bcors\b|policy\(/i,
  ],
  [
    'a process or a shell',
    /child_process|\bexec(Sync|File|FileSync)?\(|\bspawn(Sync)?\(|\bfork\(|\bshell\b|\bbackend\.execute\(|\bsh -c\b|\beval\(|new Function\(/,
  ],
  [
    'SQL',
    /\b(select\s.+\sfrom|insert\s+into|update\s+\w+\s+set|delete\s+from|drop\s+table|alter\s+table)\b|\bsql`|\.query\(|\bsql\.raw\(/i,
  ],
  [
    'input from the network',
    /req(uest)?\.(body|query|params|headers|json|text|formData)\b|\bsearchParams\b|\bformData\(|JSON\.parse\(|\bfetch\(|\bwebhook\b|\bdeserializ|\byaml\.load|\bunserialize|\bredirect\(|\.parse\(\s*(await\s+)?(req|body|input)/i,
  ],
  [
    'routes, tools or exposed code without a visible authorization',
    /\broute\(|\bdefineRoute\b|\.policy\(|\b(get|post|put|patch|delete)\(\s*['"`]\/|@Tool\b|@Agent\b|\bdefineTool\b|\bdefineCron\b|\bdefineJob\b|\.approval\(|\bonlyTools\b|innerHTML|dangerouslySetInnerHTML|\bNODE_TLS_REJECT_UNAUTHORIZED\b|\bpermissions?\b|\ballowlist\b|\bchmod\b|0o?777/i,
  ],
  [
    'paths from input',
    /\b(writeFile|writeFileSync|appendFile|createWriteStream|mkdir|mkdirSync|unlink|unlinkSync|rmSync|rm|rename|copyFile|createReadStream|readFile|readFileSync)\(|path\.(join|resolve)\(|\.\.\//,
  ],
]

/** The files an added line belongs to, from a patch with no context (`git diff -U0`). */
function addedByFile(patch: string): Map<string, string[]> {
  const files = new Map<string, string[]>()
  let current: string[] | undefined
  for (const line of patch.split('\n')) {
    const header = /^\+\+\+ (?:b\/)?(.+)$/.exec(line)
    if (header) {
      current = files.get(header[1]!) ?? []
      files.set(header[1]!, current)
    } else if (line.startsWith('+') && !line.startsWith('+++')) current?.push(line.slice(1))
  }
  return files
}

/**
 * The security surfaces a change touches (#457): dependency manifests and lockfiles, CI and workflow files, and the
 * added lines of source that handle secrets, tokens, auth, crypto or signatures, spawn a process or a shell, build
 * SQL, parse input from the network or write paths that come from input. Documents and tests count only by their
 * path. Reads nothing: `touched` is every path of the change and `patch` its diff with no context.
 */
export function securitySurfaces(facts: { touched: string[]; patch: string }): string[] {
  const found = new Set<string>()
  for (const path of facts.touched) {
    if (MANIFESTS.test(path)) found.add('dependency manifests, lockfiles or build files')
    if (CI_FILES.test(path)) found.add('CI or workflow files')
  }
  for (const [path, lines] of addedByFile(facts.patch)) {
    if (DOCS.test(path) || TESTS.test(path)) continue
    if (MANIFESTS.test(path) || CI_FILES.test(path)) continue
    const text = lines.join('\n')
    for (const [name, pattern] of CODE_SURFACES) if (pattern.test(text)) found.add(name)
  }
  return [...found]
}

/** Whether an agent's security pass can find something in the change; when not, the floor alone decides. */
export const needsSecurityReview = (facts: { touched: string[]; patch: string }): boolean =>
  securitySurfaces(facts).length > 0

/** The words a stage records when the agent pass was left out: the floor alone decided. */
export const skippedBecause = (surfaces: string[]): string | undefined =>
  surfaces.length > 0
    ? undefined
    : 'the agent security review was skipped: the change touches no security surface (dependencies, CI, secrets, auth, crypto, processes, SQL, network input, paths), so the deterministic floor alone decided'

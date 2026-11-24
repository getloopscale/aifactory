import type { RiskAssessment, RiskLevel } from '../../shared/panel'

/**
 * The risk of a finished change (#470): a level from a closed set and the reasons, over facts a run already
 * has. It reads nothing and calls no model. Nothing acts on the level yet; it is recorded and shown.
 *
 * A pattern is one line, `high: <glob>` or `medium: <glob>`. A glob without a `/` matches the file name at any
 * depth; otherwise it matches the whole path from the repository root. `**` crosses folders, `*` and `?` do not.
 */
export const RISK_LEVELS: readonly RiskLevel[] = ['low', 'medium', 'high']

/** Patterns that work with no configuration. */
export const DEFAULT_RISK_PATTERNS: readonly string[] = [
  'high: **/migrations/**',
  'high: drizzle/**',
  'high: **/auth/**',
  'high: **/authentication/**',
  'high: **/payment/**',
  'high: **/payments/**',
  'high: **/billing/**',
  'high: Dockerfile',
  'high: docker-compose*.yml',
  'high: **/terraform/**',
  'high: *.tf',
  'high: **/infra/**',
  'medium: **/api/**',
  'medium: openapi*',
  'medium: **/public-api/**',
  'medium: package.json',
]

/** From this many changed lines (outside tests) the change is `medium`, and from the second `high`. */
export const MEDIUM_LINES = 300
export const HIGH_LINES = 1000
/** From this many files the change is `medium`. */
export const MEDIUM_FILES = 15

export type RiskPattern = { level: 'medium' | 'high'; glob: string }

/** One line of the list, or nothing when it is not a pattern. */
export function parseRiskPattern(line: string): RiskPattern | undefined {
  const match = /^\s*(high|medium)\s*:\s*(\S.*?)\s*$/i.exec(line)
  if (!match) return undefined
  return { level: match[1].toLowerCase() as RiskPattern['level'], glob: match[2] }
}

/** Why a list cannot be saved, or nothing when every line is a pattern. */
export function riskPatternsProblem(lines: string[]): string | undefined {
  const bad = lines.find((line) => parseRiskPattern(line) === undefined)
  return bad === undefined
    ? undefined
    : `"${bad}" is not a pattern: write high: <glob> or medium: <glob>`
}

function globRegex(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        out += '(?:.*/)?'
        i += 2
      } else {
        out += '.*'
        i += 1
      }
    } else if (c === '*') out += '[^/]*'
    else if (c === '?') out += '[^/]'
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

/** Whether a repository-relative path matches a glob. */
export function matchesGlob(path: string, glob: string): boolean {
  const target = glob.includes('/') ? path : (path.split('/').pop() ?? path)
  return globRegex(glob).test(target)
}

export type RiskFacts = {
  /** Every path the change touches. */
  paths: string[]
  /** Lines added and removed outside tests. */
  lines: number
  /** The files that count in the size. */
  files: number
  labels: string[]
  /** The changed files the plan does not name. */
  unplanned: string[]
  /** The repository's own list; empty or absent means the defaults. */
  patterns?: string[]
}

const RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 }
const higher = (a: RiskLevel, b: RiskLevel): RiskLevel => (RANK[a] >= RANK[b] ? a : b)
const MARKDOWN = /\.(md|mdx)$/i

export type RiskResult = { level: RiskLevel; reasons: string[] }

export function assessRisk(facts: RiskFacts): RiskResult {
  const lines =
    facts.patterns && facts.patterns.length > 0 ? facts.patterns : [...DEFAULT_RISK_PATTERNS]
  const patterns = lines.flatMap((line) => parseRiskPattern(line) ?? [])
  let level: RiskLevel = 'low'
  const reasons: string[] = []
  const raise = (to: RiskLevel, reason: string) => {
    level = higher(level, to)
    reasons.push(reason)
  }
  // A Markdown file is documentation, whatever folder it sits in: no path pattern rates it.
  for (const path of facts.paths.filter((p) => !MARKDOWN.test(p))) {
    const hit = patterns.find((p) => matchesGlob(path, p.glob))
    if (hit) raise(hit.level, `${path} matches ${hit.level}: ${hit.glob}`)
  }
  if (facts.lines >= HIGH_LINES) raise('high', `the change is ${facts.lines} lines`)
  else if (facts.lines >= MEDIUM_LINES) raise('medium', `the change is ${facts.lines} lines`)
  if (facts.files >= MEDIUM_FILES) raise('medium', `the change touches ${facts.files} files`)
  if (facts.labels.some((label) => label.toLowerCase() === 'breaking')) {
    raise('medium', 'the issue is labelled breaking')
  }
  if (facts.unplanned.length > 0) {
    raise('medium', `${facts.unplanned.length} file(s) outside the plan: ${facts.unplanned[0]}`)
  }
  if (reasons.length === 0) {
    const docs = facts.paths.length > 0 && facts.paths.every((p) => MARKDOWN.test(p))
    reasons.push(
      docs ? 'only Markdown files changed' : 'no sensitive path, small change, plan followed',
    )
  }
  return { level, reasons }
}

/** The assessment stored for a commit. */
export function assessmentFor(sha: string, result: RiskResult): RiskAssessment {
  return { sha, level: result.level, reasons: result.reasons }
}

/** What the reviewer, the pull request and the notes say about an assessment. */
export function renderRisk(risk: RiskAssessment): string {
  return `Risk: ${risk.level}\n${risk.reasons.map((r) => `- ${r}`).join('\n')}`
}

/** A stored value read back: anything that is not a well-formed assessment is nothing. */
export function readRisk(value: unknown): RiskAssessment | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  if (typeof v.sha !== 'string') return undefined
  if (v.level !== 'low' && v.level !== 'medium' && v.level !== 'high') return undefined
  if (!Array.isArray(v.reasons) || !v.reasons.every((r) => typeof r === 'string')) return undefined
  return { sha: v.sha, level: v.level, reasons: v.reasons as string[] }
}

/**
 * The risk of a finished change (#470), from facts the run already has: no model, no reads. The factory only
 * records it; nothing it does depends on the level yet.
 */

export const RISK_LEVELS = ['low', 'medium', 'high'] as const
export type RiskLevel = (typeof RISK_LEVELS)[number]

export type Risk = { level: RiskLevel; reasons: string[] }

/**
 * Paths whose change is `high` unless the repository lists its own. A pattern is a glob over the path from the
 * repository root, matched without regard to case: `**` crosses folders, `*` stays inside one, `?` is one
 * character. Nothing else is special.
 */
export const DEFAULT_RISK_PATTERNS: readonly string[] = [
  // database migrations
  '**/migrations/**',
  '**/migrate/**',
  'drizzle/**',
  'prisma/migrations/**',
  '**/*.sql',
  // authentication and authorization
  '**/auth/**',
  '**/authentication/**',
  '**/authorization/**',
  '**/auth.*',
  '**/session/**',
  '**/*password*',
  // payment
  '**/payment/**',
  '**/payments/**',
  '**/billing/**',
  '**/checkout/**',
  // public API
  '**/openapi*',
  '**/api/public/**',
  '**/public-api/**',
  // infrastructure
  'Dockerfile',
  '**/Dockerfile*',
  'docker-compose*',
  'terraform/**',
  '**/*.tf',
  'infra/**',
  'k8s/**',
  'helm/**',
  'scripts/deploy*',
]

/** A diff of more changed lines than this is at least `medium`, and one of more than the second is `high`. */
export const MEDIUM_DIFF_LINES = 400
export const HIGH_DIFF_LINES = 1500

/** The most patterns a repository may list, and the longest one. */
export const MAX_RISK_PATTERNS = 50
export const MAX_RISK_PATTERN_LENGTH = 200

const rank = (level: RiskLevel): number => RISK_LEVELS.indexOf(level)

const cache = new Map<string, RegExp>()

/** The glob as a regular expression; every character but `*` and `?` is literal. */
export function globToRegExp(glob: string): RegExp {
  const known = cache.get(glob)
  if (known) return known
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          source += '(?:.*/)?'
        } else source += '.*'
      } else source += '[^/]*'
    } else if (char === '?') source += '[^/]'
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  const compiled = new RegExp(`^${source}$`, 'i')
  cache.set(glob, compiled)
  return compiled
}

/** The patterns that apply: the repository's own list, or the defaults when it has none. */
export function riskPatterns(configured: readonly string[] | undefined): readonly string[] {
  const own = (configured ?? []).map((p) => p.trim()).filter((p) => p !== '')
  return own.length > 0 ? own : DEFAULT_RISK_PATTERNS
}

const isMarkdown = (path: string) => /\.md$/i.test(path)

/**
 * The level of a change, with the reasons, the highest any signal gives:
 * - a touched path that matches a pattern is `high`, and the reason names the file and the pattern;
 * - more than `HIGH_DIFF_LINES` changed lines is `high`, more than `MEDIUM_DIFF_LINES` is `medium`;
 * - an issue labelled `breaking`, or files outside the plan, are `medium`.
 * A change that touches only Markdown ignores the patterns and the size: it is `low` unless the label or the plan says otherwise.
 */
export function classifyRisk(input: {
  touched: readonly string[]
  /** Changed text lines (added plus removed); a binary file counts none. */
  changedLines: number
  labels: readonly string[]
  unplanned: readonly string[]
  patterns?: readonly string[]
}): Risk {
  let level: RiskLevel = 'low'
  const reasons: string[] = []
  const raise = (to: RiskLevel, reason: string) => {
    if (rank(to) > rank(level)) level = to
    reasons.push(reason)
  }
  const touched = [...new Set(input.touched)]
  const docsOnly = touched.length > 0 && touched.every(isMarkdown)
  if (!docsOnly) {
    const patterns = riskPatterns(input.patterns)
    for (const file of touched) {
      const pattern = patterns.find((p) => globToRegExp(p).test(file))
      if (pattern !== undefined) raise('high', `${file} matches the pattern ${pattern}`)
    }
    if (input.changedLines > HIGH_DIFF_LINES) {
      raise('high', `${input.changedLines} changed lines, more than ${HIGH_DIFF_LINES}`)
    } else if (input.changedLines > MEDIUM_DIFF_LINES) {
      raise('medium', `${input.changedLines} changed lines, more than ${MEDIUM_DIFF_LINES}`)
    }
  }
  if (input.labels.some((label) => label.toLowerCase() === 'breaking')) {
    raise('medium', 'the issue is labelled breaking')
  }
  if (input.unplanned.length > 0) {
    raise('medium', `${input.unplanned.length} changed file(s) outside the plan`)
  }
  if (reasons.length === 0)
    reasons.push(docsOnly ? 'only Markdown files changed' : 'no risk signal')
  return { level, reasons }
}

/** One line for a reader: the level and why. */
export function renderRisk(risk: Risk): string {
  return `${risk.level} (${risk.reasons.join('; ')})`
}

/** The text a pattern list is stored as: trimmed, no blanks, no repeats, each a bounded plain glob; or the reason it is not. */
export function parseRiskPatterns(
  input: readonly string[],
): { ok: true; patterns: string[] } | { ok: false; error: string } {
  const patterns = [...new Set(input.map((p) => p.trim()).filter((p) => p !== ''))]
  if (patterns.length > MAX_RISK_PATTERNS) {
    return { ok: false, error: `at most ${MAX_RISK_PATTERNS} patterns` }
  }
  for (const p of patterns) {
    if (p.length > MAX_RISK_PATTERN_LENGTH)
      return { ok: false, error: `${p.slice(0, 40)}… is too long` }
    if (p.startsWith('/') || p.includes('..') || /[\0\n\r]/.test(p)) {
      return { ok: false, error: `${p} is not a path pattern from the repository root` }
    }
  }
  return { ok: true, patterns }
}

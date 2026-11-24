import type { SandboxBackend } from '@theokit/agents/sandbox'

import type { Finding } from './review'

/**
 * The deterministic floor of the security review (#241): what a change adds that is wrong whatever any agent
 * says. It reads a diff and audit output and decides nothing else; a finding here is a `blocker`.
 */

const SECRET_PATTERNS: { name: string; cwe: string; pattern: RegExp }[] = [
  { name: 'an AWS access key id', cwe: 'CWE-798', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'a private key', cwe: 'CWE-321', pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { name: 'a GitHub token', cwe: 'CWE-798', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'a Slack token', cwe: 'CWE-798', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'an API secret key', cwe: 'CWE-798', pattern: /\bsk-[A-Za-z0-9_-]{24,}\b/ },
]

/** The key AWS documents for examples: not a secret. */
const DOCUMENTED = /EXAMPLE$/

/**
 * The secrets a unified diff adds, each with the file and line it lands on. Only added lines are read, so a
 * secret the base already holds is not the change's. Read it from `git diff -U0 --no-color`.
 */
export function secretsAdded(patch: string): Finding[] {
  const findings: Finding[] = []
  let file: string | undefined
  let line = 0
  // Lines of the current hunk still to read: a line inside one is content, whatever it starts with.
  let removing = 0
  let adding = 0
  for (const text of patch.split('\n')) {
    if (removing > 0 || adding > 0) {
      if (text.startsWith('+')) {
        adding -= 1
        findings.push(...secretsIn(text.slice(1), file, line))
        line += 1
      } else if (text.startsWith('-')) {
        removing -= 1
      }
      continue
    }
    if (text.startsWith('+++ ')) {
      file = text === '+++ /dev/null' ? undefined : text.replace(/^\+\+\+ b\//, '')
    } else if (text.startsWith('@@')) {
      const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text)
      removing = Number(hunk?.[1] ?? 1)
      line = Number(hunk?.[2] ?? 0)
      adding = Number(hunk?.[3] ?? 1)
    }
  }
  return findings
}

function secretsIn(content: string, file: string | undefined, line: number): Finding[] {
  if (!file) return []
  const found: Finding[] = []
  for (const { name, cwe, pattern } of SECRET_PATTERNS) {
    const hit = pattern.exec(content)
    if (hit && !DOCUMENTED.test(hit[0])) {
      found.push({
        severity: 'blocker',
        file: `${file}:${line}`,
        issue: `the change adds ${name} (${cwe}); remove it and rotate the credential`,
      })
    }
  }
  return found
}

export type Advisory = { id: string; pkg: string; severity: string }

const SEVERE = new Set(['high', 'critical'])

/**
 * The advisories in the JSON of `npm audit` or `pnpm audit`, or `undefined` when the output is not one the
 * scan understands: an unreadable audit is never a pass.
 */
export function parseAudit(output: string): Advisory[] | undefined {
  let json: unknown
  try {
    json = JSON.parse(output)
  } catch {
    return undefined
  }
  if (typeof json !== 'object' || json === null) return undefined
  const { advisories, vulnerabilities } = json as {
    advisories?: Record<string, Record<string, unknown>>
    vulnerabilities?: Record<string, { via?: unknown[] }>
  }
  const found: Advisory[] = []
  if (advisories && typeof advisories === 'object') {
    for (const [key, a] of Object.entries(advisories)) {
      found.push({
        id: String(a.github_advisory_id ?? a.id ?? key),
        pkg: String(a.module_name ?? 'unknown'),
        severity: String(a.severity ?? 'unknown'),
      })
    }
    return found
  }
  if (vulnerabilities && typeof vulnerabilities === 'object') {
    for (const [pkg, v] of Object.entries(vulnerabilities)) {
      for (const via of v.via ?? []) {
        if (typeof via !== 'object' || via === null) continue
        const o = via as Record<string, unknown>
        found.push({
          id: String(o.url ?? o.source ?? `${pkg}:${o.title ?? ''}`),
          pkg,
          severity: String(o.severity ?? 'unknown'),
        })
      }
    }
    return found
  }
  return undefined
}

/**
 * The high or critical advisories the head has and the base does not, as blockers. When either audit could
 * not be read, the answer is one blocker saying so: a person decides, nothing passes by default.
 */
export function advisoriesAdded(baseAudit: string, headAudit: string): Finding[] {
  const base = parseAudit(baseAudit)
  const head = parseAudit(headAudit)
  if (!base || !head) {
    return [
      {
        severity: 'blocker',
        file: 'package.json',
        issue:
          'the dependency audit could not be read, so the change cannot be shown to add no advisory',
      },
    ]
  }
  const known = new Set(base.map((a) => `${a.id}|${a.pkg}`))
  return head
    .filter((a) => SEVERE.has(a.severity) && !known.has(`${a.id}|${a.pkg}`))
    .map((a) => ({
      severity: 'blocker' as const,
      file: 'package.json',
      issue: `the change adds the ${a.severity} advisory ${a.id} in ${a.pkg} (CWE-1395); upgrade to a patched version`,
    }))
}

const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock']

/** The audit command of the package manager whose lockfile is `lockfile`. */
const auditCommand = (lockfile: string) =>
  lockfile === 'pnpm-lock.yaml' ? 'pnpm audit --json' : 'npm audit --json'

/**
 * The advisories a change adds, as blockers, when it touches a lockfile: the audit of the base (its manifest
 * and lockfile extracted to a directory of its own) against the audit of the head. A change that touches no
 * lockfile adds none. An audit that cannot be run or read is a blocker, never a pass (#241).
 */
export async function auditBlockers(
  backend: SandboxBackend,
  repoDir: string,
  base: string,
  touched: string[],
): Promise<Finding[]> {
  const lockfile = LOCKFILES.find((name) => touched.includes(name))
  if (!lockfile) return []
  const audit = auditCommand(lockfile)
  const run = async (command: string) => {
    try {
      return (await backend.execute(command, { timeoutMs: 3 * 60_000 })).stdout
    } catch {
      return ''
    }
  }
  const git = `git -C ${repoDir}`
  const files = `$(${git} ls-tree --name-only ${base} | grep -E '^(package.json|${lockfile}|pnpm-workspace.yaml|.npmrc)$')`
  const baseAudit = await run(
    `d=$(mktemp -d) && ${git} archive ${base} -- ${files} | tar -x -C "$d" && (cd "$d" && ${audit}); rm -rf "$d"`,
  )
  const headAudit = await run(`cd ${repoDir} && ${audit}`)
  return advisoriesAdded(baseAudit, headAudit)
}

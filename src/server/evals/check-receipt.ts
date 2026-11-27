import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { AGENT_CONFIGURATION } from './cases'

/**
 * A recorded pass of the deploy check (docs/adr/0008): what a check that measured the whole quick set, and the
 * readiness judge, leaves behind so the next deploy of the same agent configuration runs no case again.
 *
 * The records live in the git common directory, which no working tree holds: a worktree and the main checkout
 * share it, a task's sandbox has its own clone and cannot write it, and only `recordPass` (called by the check
 * itself, after every case passed) creates one.
 */

/** Bump it when the way a fingerprint is made changes: every older record then stops matching. */
export const RECEIPT_VERSION = 1

/** The files whose change changes what the check measures or how it decides, besides the agent configuration. */
export const CHECK_IMPLEMENTATION = [
  'src/server/evals/cases.ts',
  'src/server/evals/compare.ts',
  'src/server/evals/suite.ts',
  'src/server/evals/run-case.ts',
  'src/server/evals/check-receipt.ts',
  'src/server/evals/suite.evals.test.ts',
  'src/server/scheduler/judge.ts',
  'src/server/scheduler/readiness.ts',
  'src/server/agents/prompts/readiness.ts',
]

const AGENTS_FOLDER = 'src/server/agents'
const isTest = (path: string) => /\.test\.[cm]?[jt]sx?$/.test(path)

function sha(...parts: string[]): string {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(`${part.length}:`).update(part)
  return hash.digest('hex')
}

/** A file's digest, `absent` when it is not there, so an addition or a deletion changes the fingerprint. */
function digestOf(root: string, path: string): string {
  try {
    return sha(readFileSync(join(root, path)).toString('latin1'))
  } catch {
    return 'absent'
  }
}

function walk(root: string, folder: string): string[] {
  let entries
  try {
    entries = readdirSync(join(root, folder), { withFileTypes: true })
  } catch {
    return []
  }
  return entries.flatMap((entry) => {
    const path = `${folder}/${entry.name}`
    return entry.isDirectory() ? walk(root, path) : [path]
  })
}

/** The agent configuration files of the working tree, tests left out, sorted. */
export function configurationFiles(root: string): string[] {
  const all = [...AGENT_CONFIGURATION, ...walk(root, AGENTS_FOLDER)].filter((p) => !isTest(p))
  return [...new Set([...all, ...CHECK_IMPLEMENTATION])].sort()
}

/** What a pass measured: file contents and paths, the baseline, the quick cases and the effective agent setup. */
export type FingerprintInput = {
  root: string
  setup: Record<string, string>
  baseline: string
  cases: string
}

export function fingerprint(input: FingerprintInput): string {
  const files = configurationFiles(input.root).map((p) => `${p}=${digestOf(input.root, p)}`)
  const setup = Object.keys(input.setup)
    .sort()
    .map((k) => `${k}=${input.setup[k]}`)
  return sha(
    `v${RECEIPT_VERSION}`,
    files.join('\n'),
    setup.join('\n'),
    sha(input.baseline),
    sha(input.cases),
  )
}

/** The folder of the records: under the git common directory (`.git` of the main checkout), which linked worktrees share. */
export function receiptsFolder(root: string, commonDir: string): string {
  const common = isAbsolute(commonDir) ? commonDir : resolve(root, commonDir)
  return join(common, 'aifactory-evals', 'passes')
}

export type Pass = {
  version: number
  fingerprint: string
  commit: string
  completedAt: string
  quickCases: number
  judgeCases: number
}

/** The quick cases and judge cases a pass has to cover; nothing skipped, none failed. */
export type Completed = {
  ran: boolean
  ok: boolean
  reasons: string[]
  quickCases: number
  skipped: number
  judgeCases: number
  judgePassed: number
}

/** Whether a finished check measured everything and passed: only then it is worth recording. */
export function completePass(check: Completed): boolean {
  return (
    check.ran &&
    check.ok &&
    check.reasons.length === 0 &&
    check.quickCases > 0 &&
    check.skipped === 0 &&
    check.judgeCases > 0 &&
    check.judgePassed === check.judgeCases
  )
}

function valid(value: unknown, wanted: string): value is Pass {
  if (typeof value !== 'object' || value === null) return false
  const p = value as Record<string, unknown>
  return (
    p.version === RECEIPT_VERSION &&
    p.fingerprint === wanted &&
    typeof p.commit === 'string' &&
    typeof p.completedAt === 'string' &&
    Number.isInteger(p.quickCases) &&
    (p.quickCases as number) > 0 &&
    Number.isInteger(p.judgeCases) &&
    (p.judgeCases as number) > 0
  )
}

/** The recorded pass of this fingerprint, or `undefined`: a missing, unreadable or malformed record is no pass. */
export function findPass(folder: string, wanted: string): Pass | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(join(folder, `${wanted}.json`), 'utf8'))
    return valid(value, wanted) ? value : undefined
  } catch {
    return undefined
  }
}

/** Writes the record whole or not at all. A folder that cannot be written is an error the caller reports. */
export function recordPass(folder: string, pass: Pass): void {
  mkdirSync(folder, { recursive: true })
  const target = join(folder, `${pass.fingerprint}.json`)
  const temporary = `${target}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(pass, null, 2))
  renameSync(temporary, target)
}

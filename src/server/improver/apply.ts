import type { Database } from '../db'
import { improverDecision } from '../db/schema'
import { fileOnce } from '../coordinator/file-once'
import type { CoordinatorMode } from '../coordinator/mode'
import type { CreatedIssue, NewIssue } from '../github/issues-api'
import { FACTORY_LABEL_SPEC } from '../panel/work'

import {
  SKIP_TEXT,
  decideRepository,
  improveSignature,
  orderRepositories,
  type ImproverKind,
  type RepoFacts,
} from './decide'
import { readFacts, type IssueReader } from './facts'
import type { Proposal, ScoutAnswer } from './scout'

/** The only module of the improver with side effects: it scouts, records every decision and, in `auto`, files. */

export type ImproverMode = CoordinatorMode

export const IMPROVEMENT_LABELS = [
  FACTORY_LABEL_SPEC,
  { name: 'improvement', color: '0e8a16', description: 'Maintenance the improver proposed' },
  {
    name: 'priority:5',
    color: 'fbca04',
    description: 'The factory takes this after the other priorities',
  },
]

export type ImproverDeps = {
  db: Database
  now?: () => Date
  readIssue: IssueReader
  scout: (repository: string, kind: ImproverKind) => Promise<ScoutAnswer>
  ensureLabels: (repository: string, labels: typeof IMPROVEMENT_LABELS) => Promise<void>
  openIssue: (repository: string, issue: NewIssue) => Promise<CreatedIssue>
}

export type ImproverResult = Record<'proposed' | 'nothing_found' | 'skipped' | 'error', number>

type Row = typeof improverDecision.$inferInsert

/** The issue the improver files: who proposed it, the kind and the evidence. */
export function improvementIssue(kind: ImproverKind, p: Proposal): NewIssue {
  const body = [
    `The factory's improver proposed this (\`${kind}\`). It looks for small maintenance in a repository whose own work is quiet.`,
    '',
    `**Target:** \`${p.target}\``,
    '',
    p.body,
    '',
    '## Evidence',
    '',
    p.evidence || 'The scout gave none.',
  ].join('\n')
  return { title: p.title, body, labels: IMPROVEMENT_LABELS.map((l) => l.name) }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Files a proposal once per signature, on the repository itself. A signature filed before is never filed again. */
async function file(deps: ImproverDeps, repo: string, kind: ImproverKind, p: Proposal, now: Date) {
  const signature = improveSignature(kind, p.target)
  const done = await fileOnce(deps.db, { signature, repository: repo, now }, async () => {
    await deps.ensureLabels(repo, IMPROVEMENT_LABELS)
    return deps.openIssue(repo, improvementIssue(kind, p))
  })
  return { signature, done }
}

async function scoutOne(
  deps: ImproverDeps,
  repo: RepoFacts,
  kind: ImproverKind,
  mode: 'trial' | 'auto',
  now: Date,
): Promise<Row> {
  const base = { repository: repo.repository, kind, mode }
  const answer = await deps.scout(repo.repository, kind)
  if (answer.status === 'error') return { ...base, outcome: 'error', reason: answer.reason }
  if (answer.status === 'none') {
    return { ...base, outcome: 'nothing_found', reason: 'the scout found nothing worth doing' }
  }
  const { proposal } = answer
  const signature = improveSignature(kind, proposal.target)
  const shown = { ...base, signature, proposal }
  if (mode === 'trial') {
    return { ...shown, outcome: 'proposed', reason: `would file: ${proposal.title}` }
  }
  try {
    const { done } = await file(deps, repo.repository, kind, proposal, now)
    if ('filed' in done) {
      return {
        ...shown,
        outcome: 'proposed',
        reason: `filed: ${proposal.title}`,
        issueNumber: done.filed.number,
      }
    }
    return {
      ...shown,
      outcome: 'skipped',
      reason:
        done.already === null
          ? 'another pass is filing this signature'
          : `the signature was filed as #${done.already}, open or closed, and is not proposed again`,
    }
  } catch (error) {
    return { ...shown, outcome: 'error', reason: message(error).slice(0, 600) }
  }
}

/**
 * One pass: for each enabled repository, in a fixed order that moves one each day, either a reason to skip it
 * or a scout of the kind proposed least recently. Every repository gets one `improver_decision` row. In `trial`
 * nothing is filed; the scout runs and the row says what would be.
 */
export async function improve(deps: ImproverDeps, mode: ImproverMode): Promise<ImproverResult> {
  const result: ImproverResult = { proposed: 0, nothing_found: 0, skipped: 0, error: 0 }
  if (mode === 'off') return result
  const now = (deps.now ?? (() => new Date()))()
  const facts = orderRepositories(await readFacts(deps.db, now, deps.readIssue), now)
  for (const repo of facts) {
    const decision = decideRepository(repo, result.proposed)
    const row: Row =
      decision.action === 'skip'
        ? {
            repository: repo.repository,
            kind: decision.kind,
            mode,
            outcome: 'skipped',
            reason: `${decision.reason}: ${SKIP_TEXT[decision.reason]}`,
          }
        : await scoutOne(deps, repo, decision.kind, mode, now)
    await deps.db.insert(improverDecision).values(row)
    result[row.outcome]++
  }
  return result
}

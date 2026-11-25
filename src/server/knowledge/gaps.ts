import { fileOnce } from '../coordinator/file-once'
import type { Database } from '../db'
import type { CreatedIssue, NewIssue } from '../github/issues-api'
import type { GapsView } from '../../shared/knowledge'

import { gapHash } from './format'
import {
  answeredQuestions,
  gapIsOpen,
  gapsWithStatus,
  loadKnowledgeConfig,
  resolveGap,
  type GapRow,
} from './store'

/** How many tasks of a project must ask the same question before it becomes an issue. */
export const GAP_ISSUE_THRESHOLD = 3

/** The prefix of the `failure_signature` rows of these issues, so Evolve leaves them alone. */
export const GAP_SIGNATURE_PREFIX = 'knowledge_gap:'

export const gapSignature = (
  knowledgeRepository: string,
  gap: Pick<GapRow, 'repository' | 'question'>,
) => `${GAP_SIGNATURE_PREFIX}${knowledgeRepository}:${gapHash(gap.repository, gap.question)}`

/**
 * The issue for a gap, on the knowledge repository. It carries no label: that repository is never a project,
 * so nothing the factory does reads it as work, and only the owner writes a rule.
 */
export function issueForGap(gap: GapRow): NewIssue {
  const tasks = gap.tasks
    .map((t) =>
      t.issueNumber < 0
        ? `- a Linear item (${t.role})`
        : `- https://github.com/${gap.repository}/issues/${t.issueNumber} (${t.role})`,
    )
    .join('\n')
  return {
    title: `Rule needed in ${gap.repository}: ${gap.question.slice(0, 80)}`,
    body: `Agents working on ${gap.repository} needed to know this and the knowledge base does not say it:\n\n> ${gap.question}\n\nAsked by ${gap.tasks.length} tasks:\n\n${tasks}\n\nThe answer, if it is a rule, goes in the knowledge base under knowledge/projects/${gap.repository}/.`,
  }
}

class NoLongerOpen extends Error {}

export type GapFilingDeps = {
  db: Database
  now?: () => Date
  openIssue: (repository: string, issue: NewIssue) => Promise<CreatedIssue>
}

/**
 * Files, once each, the open gaps that enough tasks asked (`fileOnce`). The gap is read again inside the
 * claim, so one the owner answered or dismissed meanwhile is not filed; a request already on its way cannot
 * be recalled. Returns the issue numbers filed.
 */
export async function fileKnowledgeGaps(deps: GapFilingDeps): Promise<number[]> {
  const config = await loadKnowledgeConfig(deps.db)
  if (!config) return []
  const filed: number[] = []
  for (const gap of await gapsWithStatus(deps.db, 'open')) {
    if (gap.tasks.length < GAP_ISSUE_THRESHOLD) continue
    try {
      const result = await fileOnce(
        deps.db,
        {
          signature: gapSignature(config.repository, gap),
          repository: config.repository,
          now: (deps.now ?? (() => new Date()))(),
        },
        async () => {
          if (!(await gapIsOpen(deps.db, gap.id))) throw new NoLongerOpen()
          return deps.openIssue(config.repository, issueForGap(gap))
        },
      )
      if ('filed' in result) filed.push(result.filed.number)
    } catch (error) {
      if (!(error instanceof NoLongerOpen)) throw error
    }
  }
  return filed
}

/** What the panel shows: the open gaps, and the answers the owner already gave that may be rules. */
export async function gapsView(db: Database): Promise<GapsView> {
  const [gaps, answered] = await Promise.all([gapsWithStatus(db, 'open'), answeredQuestions(db)])
  return {
    gaps: gaps.map((g) => ({
      id: g.id,
      repository: g.repository,
      question: g.question,
      tasks: g.tasks.map((t) => ({ taskId: t.taskId, issueNumber: t.issueNumber, role: t.role })),
    })),
    candidates: answered.map((a) => ({
      id: a.id,
      repository: a.repository,
      issueNumber: a.issueNumber,
      taskId: a.taskId,
      question: a.question,
      answer: a.answer,
    })),
  }
}

export const setGapStatus = (db: Database, id: number, status: 'answered' | 'dismissed') =>
  resolveGap(db, id, status)

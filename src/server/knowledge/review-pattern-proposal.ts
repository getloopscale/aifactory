import { and, eq, inArray, isNull } from 'drizzle-orm'

import { getPool } from '../db'
import { reviewPattern, task } from '../db/schema'

import { patternRulePath, renderPatternRule } from './format'
import { loadKnowledgeConfig } from './store'
import { context, KnowledgeRefused, serialized, syncKnowledge, type KnowledgeDeps } from './sync'

/**
 * "Propose as a rule": opens one pull request on the knowledge repository that adds a review pattern as a rule
 * of its project, from a branch of the factory's own into the owner's. The factory only opens it; the owner
 * merges. Nothing here merges anything, and a test fails if a merge is called.
 */

/** The factory's branch for one pattern's rule. It is the factory's own, so it may be replaced. */
export const patternBranch = (id: number) => `factory-rule-${id}`

type Proposal = { url: string; path: string }

/**
 * One proposal per pattern at a time, on any process: a blocking advisory lock on one pool connection, so a second
 * call waits, then reads the pattern again and finds the first one's pull request.
 */
export async function proposePatternRule(
  deps: KnowledgeDeps,
  patternId: number,
): Promise<Proposal> {
  const client = await getPool().connect()
  const key = `pattern-rule:${patternId}`
  try {
    await client.query('select pg_advisory_lock(hashtext($1))', [key])
    try {
      return await proposeLocked(deps, patternId)
    } finally {
      await client.query('select pg_advisory_unlock(hashtext($1))', [key])
    }
  } finally {
    client.release()
  }
}

async function proposeLocked(deps: KnowledgeDeps, patternId: number): Promise<Proposal> {
  const [pattern] = await deps.db
    .select()
    .from(reviewPattern)
    .where(eq(reviewPattern.id, patternId))
  if (!pattern) throw new KnowledgeRefused('that pattern does not exist')
  const path = patternRulePath(pattern.repository, pattern.id, pattern.classKey)
  if (pattern.proposalUrl) return { url: pattern.proposalUrl, path }
  const config = await loadKnowledgeConfig(deps.db)
  if (!config) throw new KnowledgeRefused('choose a knowledge repository first')
  if (config.repository === pattern.repository) {
    throw new KnowledgeRefused('the knowledge repository is never a project')
  }
  const state = await serialized(() => syncKnowledge(deps)).catch((error: unknown) => {
    throw new KnowledgeRefused(
      `the factory could not read ${config.repository}: ${error instanceof Error ? error.message : String(error)}`,
    )
  })
  if (!state?.knowledgeSha) throw new KnowledgeRefused(`${config.repository} could not be read`)
  const issues = await deps.db
    .select({ id: task.id, issueNumber: task.issueNumber })
    .from(task)
    .where(inArray(task.id, pattern.taskIds))
  const byTask = new Map(issues.map((t) => [t.id, t.issueNumber]))
  const sources = pattern.taskIds.flatMap((taskId) => {
    const issueNumber = byTask.get(taskId)
    return issueNumber === undefined ? [] : [{ taskId, issueNumber }]
  })
  const c = await context(deps, config)
  const commit = await c.mirror.commit({
    parent: state.knowledgeSha,
    files: [
      {
        path,
        content: renderPatternRule({
          repository: pattern.repository,
          className: pattern.className,
          invariant: pattern.invariant,
          sources,
          at: c.now,
        }),
      },
    ],
    message: `Add a review pattern of ${pattern.repository} as a rule\n\nClass: ${pattern.className}\n`,
    author: deps.author,
    date: c.now,
  })
  await c.mirror.push(c.url, commit, patternBranch(pattern.id), { token: c.token, force: true })
  const pull = await deps.api.openPullRequest(config.repository, c.token, {
    head: patternBranch(pattern.id),
    base: state.branch,
    title: `Rule for ${pattern.repository}: ${pattern.className}`.slice(0, 200),
    body: [
      `The reviewer blocked ${pattern.taskIds.length} tasks of ${pattern.repository} for the same class of defect: "${pattern.className}".`,
      '',
      `This pull request adds it as a rule under \`knowledge/projects/${pattern.repository}/\`. Read it, change it, or close it: the factory merges nothing.`,
    ].join('\n'),
  })
  await deps.db
    .update(reviewPattern)
    .set({ proposalUrl: pull.url })
    .where(and(eq(reviewPattern.id, pattern.id), isNull(reviewPattern.proposalUrl)))
  return { url: pull.url, path }
}

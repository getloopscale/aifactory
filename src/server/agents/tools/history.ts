import { tool } from 'theokit/server/define'
import { z } from 'zod'

import { getDb } from '../../db'
import { readHistory, TRANSCRIPT_WARNING } from '../../trace/history'
import { lookupTasks, searchPasses } from '../../trace/search'

/** Both read only: a query to the database and GET requests to Looptrace, nothing written anywhere. */

export const historySearchTool = tool('history_search')
  .describe(
    `Search what the agents did in past tasks. Gives at most 10 passes: task id, issue number and title, repository, role, attempt, when it ran and a preview. Then read one with history_read. ${TRANSCRIPT_WARNING}`,
  )
  .input(
    z.object({
      query: z.string().min(1).max(200),
      repository: z.string().max(200).optional().describe('owner/name'),
      role: z.enum(['builder', 'planner', 'reviewer', 'merger', 'security', 'lens']).optional(),
      from: z.string().max(40).optional().describe('ISO date'),
      to: z.string().max(40).optional().describe('ISO date'),
    }),
  )
  .execute(async (input) => {
    const { query, ...filters } = input
    const answer = await searchPasses({ q: query, ...filters }, lookupTasks(getDb()))
    if (!answer.enabled)
      return { note: 'History search is off: FACTORY_TRACE_ENDPOINT is not set.' }
    return { note: TRANSCRIPT_WARNING, results: answer.results }
  })
  .build()

export const historyReadTool = tool('history_read')
  .describe(
    `Read the steps of one agent pass of a task, in order. With no role or attempt, the most recent pass. The answer is cut at a fixed length and says so. ${TRANSCRIPT_WARNING}`,
  )
  .input(
    z.object({
      taskId: z.number().int().positive(),
      role: z.enum(['builder', 'planner', 'reviewer', 'merger', 'security', 'lens']).optional(),
      attempt: z.number().int().min(0).optional(),
    }),
  )
  .execute(async (input) => readHistory(getDb(), input))
  .build()

export const HISTORY_TOOLS = {
  history_search: historySearchTool,
  history_read: historyReadTool,
}

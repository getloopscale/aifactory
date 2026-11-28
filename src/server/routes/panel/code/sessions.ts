import { randomUUID } from 'node:crypto'

import { route } from '@getloopscale/loopzero/server/define'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

import { CODE_MODES } from '../../../../shared/code'
import { createSession, listSessions } from '../../../code/store'
import { getDb } from '../../../db'
import { repository } from '../../../db/schema'
import { integrationBranch } from '../../../factory/branches'
import { DEFAULT_HARNESS, canStart, harnessRegistry } from '../../../factory/harness-registry'
import { errorMessage } from '../../../factory/error-message'
import { actionDeps } from '../../../panel/deps'
import { ownerOnly } from '../../../panel/policy'

/** The agents that could start now: the ones whose credential is there. */
function startable(): string[] {
  const registry = harnessRegistry()
  return Object.keys(registry).filter((name) => canStart(registry, name))
}

/** The longest title a session takes from its first message: what a row of the list shows. */
export const TITLE_LENGTH = 60

/** The start of the first message, on one line and cut at a word, as the title of a session given none. */
export function titleFrom(message: string): string {
  const line = message.replace(/\s+/g, ' ').trim()
  if (line.length <= TITLE_LENGTH) return line
  const cut = line.slice(0, TITLE_LENGTH - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > TITLE_LENGTH / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/**
 * Whether GitHub says the repository has no such branch. A read that fails (no token, a limit, GitHub down) is not
 * an answer: the session is created and its turn says what checking out found.
 */
async function branchMissing(repository: string, branch: string): Promise<boolean> {
  try {
    const { github, api } = actionDeps()
    const { token } = await github.installationToken(repository)
    return (await api.branchHead(repository, token, branch)) === undefined
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'code_base_branch_unread',
        repository,
        branch,
        error: errorMessage(error),
      }),
    )
    return false
  }
}

/** The sessions, newest activity first, and the agents a new one may use. */
export const GET = route()
  .policy(ownerOnly)
  .handler(async () => ({ sessions: await listSessions(), harnesses: startable() }))
  .build()

/** Starts a session. The work branch is the server's to name, so two sessions never share one. */
export const POST = route()
  .policy(ownerOnly)
  .body(
    z.object({
      repository: z.string().min(3).max(200),
      baseBranch: z.string().min(1).max(200).optional(),
      harness: z.string().min(1).max(60).optional(),
      model: z.string().min(1).max(100).optional(),
      mode: z.enum(CODE_MODES).default('ask'),
      title: z.string().max(200).optional(),
      firstMessage: z.string().max(20_000).optional(),
    }),
  )
  .handler(async ({ body }) => {
    const [enabled] = await getDb()
      .select({ id: repository.id, baseBranch: repository.baseBranch })
      .from(repository)
      .where(and(eq(repository.fullName, body.repository), eq(repository.enabled, true)))
    if (!enabled) {
      return Response.json(
        { error: 'refused', message: `${body.repository} is not an enabled repository.` },
        { status: 400 },
      )
    }
    const harness = body.harness ?? DEFAULT_HARNESS
    if (!startable().includes(harness)) {
      return Response.json(
        { error: 'refused', message: `The agent ${harness} cannot start now.` },
        { status: 409 },
      )
    }
    const baseBranch = body.baseBranch ?? integrationBranch(enabled)
    if (await branchMissing(body.repository, baseBranch)) {
      return Response.json(
        {
          error: 'refused',
          message: `The branch ${baseBranch} does not exist in ${body.repository}.`,
        },
        { status: 400 },
      )
    }
    const session = await createSession({
      title: body.title?.trim() || titleFrom(body.firstMessage ?? '') || body.repository,
      repository: body.repository,
      baseBranch,
      workBranch: `code/${randomUUID().slice(0, 8)}`,
      harness,
      model: body.model,
      mode: body.mode,
    })
    return { session }
  })
  .build()

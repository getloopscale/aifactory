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
import { ownerOnly } from '../../../panel/policy'

/** The agents that could start now: the ones whose credential is there. */
function startable(): string[] {
  const registry = harnessRegistry()
  return Object.keys(registry).filter((name) => canStart(registry, name))
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
    const session = await createSession({
      title: body.title?.trim() || body.repository,
      repository: body.repository,
      baseBranch: body.baseBranch ?? integrationBranch(enabled),
      workBranch: `code/${randomUUID().slice(0, 8)}`,
      harness,
      model: body.model,
      mode: body.mode,
    })
    return { session }
  })
  .build()

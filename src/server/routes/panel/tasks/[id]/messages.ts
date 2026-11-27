import { route } from '@getloopscale/loopzero/server/define'
import { z } from 'zod'

import { MESSAGE_MAX } from '../../../../../shared/panel'
import { guideTask } from '../../../../panel/actions'
import { sendMessage } from '../../../../panel/conversation'
import { actionDeps, conversationDeps, refusal } from '../../../../panel/deps'
import { ownerOnly } from '../../../../panel/policy'

/** The owner writes to the agent of a task that stopped, to ask it something or to guide it. */
export const POST = route()
  .policy(ownerOnly)
  .params(z.object({ id: z.coerce.number().int().positive() }))
  .body(z.object({ text: z.string().min(1).max(MESSAGE_MAX), mode: z.enum(['ask', 'guide']) }))
  .handler(async ({ params, body }) => {
    try {
      const actions = actionDeps()
      return await sendMessage(
        { ...conversationDeps(), guide: (taskId, text) => guideTask(actions, taskId, text) },
        params.id,
        body,
      )
    } catch (error) {
      return refusal(error)
    }
  })
  .build()

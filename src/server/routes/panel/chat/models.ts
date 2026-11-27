import { route } from '@getloopscale/loopzero/server/define'

import { chatModels } from '../../../panel/chat-models'
import { ownerOnly } from '../../../panel/policy'

/** The model behind each choice of the picker in the message box. */
export const GET = route()
  .policy(ownerOnly)
  .handler(async () => chatModels())
  .build()

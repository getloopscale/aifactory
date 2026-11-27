import { guideAgent } from '../factory/guides'
import { ownerOnly } from '../panel/policy'

/** Only the signed-in owner talks to a guide: it can act on the factory and spends model credit. */
export const policy = ownerOnly

/** The guide of the "code" page on the owner's ChatGPT subscription, at `POST /api/agents/guide-code-codex`. */
export default guideAgent('code', 'codex')

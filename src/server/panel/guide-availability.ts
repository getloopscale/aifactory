import { outcome, type Facts } from '../factory/transitions'

import type { GuideView } from '../../shared/panel'

/** Whether a message may guide the agent of this task, asked of `transitions.ts` and not decided again. */
export function guideAvailability(task: Facts): GuideView {
  const decided = outcome({ ...task, conversation: 'guide' }, 'conversation')
  return decided.kind === 'action' && decided.action === 'guide_agent'
    ? { available: true }
    : { available: false, reason: decided.kind === 'action' ? '' : decided.reason }
}

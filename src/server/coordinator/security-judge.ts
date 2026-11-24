/**
 * The judgement of a security exception (#241): what a security agent may answer, from a closed set, and
 * nothing else. "Ignore the advisory", "lower the level" and "skip the check" are not in the set, so no answer
 * can ask for them: only a person adds an exception, with a reason and an expiry.
 */
export const SECURITY_ACTIONS = ['fix', 'replace', 'wait_upstream', 'escalate'] as const
export type SecurityAction = (typeof SECURITY_ACTIONS)[number]

export type SecurityJudgement =
  | { action: 'fix'; version: string; reason: string }
  | { action: 'replace'; reason: string }
  | { action: 'wait_upstream'; advisory: string; tracked: string; reason: string }
  | { action: 'escalate'; reason: string }

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

/**
 * Reads the agent's JSON answer. An answer outside the closed set, one missing what its action needs
 * (a `fix` with no version, a `wait_upstream` with no advisory or tracker) or one that does not parse is an
 * `escalate`: a person decides, nothing is ignored.
 */
export function parseSecurityJudgement(answer: string): SecurityJudgement {
  const escalate = (reason: string): SecurityJudgement => ({ action: 'escalate', reason })
  let json: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(
      answer.slice(answer.indexOf('{'), answer.lastIndexOf('}') + 1),
    )
    if (typeof parsed !== 'object' || parsed === null)
      return escalate('the answer is not an object')
    json = parsed as Record<string, unknown>
  } catch {
    return escalate('the answer is not JSON')
  }
  const reason = text(json.reason) || 'no reason given'
  switch (json.action) {
    case 'fix':
      return text(json.version)
        ? { action: 'fix', version: text(json.version), reason }
        : escalate('a fix names no patched version')
    case 'replace':
      return { action: 'replace', reason }
    case 'wait_upstream':
      return text(json.advisory) && text(json.tracked)
        ? {
            action: 'wait_upstream',
            advisory: text(json.advisory),
            tracked: text(json.tracked),
            reason,
          }
        : escalate('a wait names no advisory or no place where the fix is tracked')
    case 'escalate':
      return escalate(reason)
    default:
      return escalate(`"${String(json.action)}" is not an action a security judgement may take`)
  }
}

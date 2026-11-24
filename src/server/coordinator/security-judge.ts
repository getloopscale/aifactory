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

/**
 * The coordinator's decision for a `security` exception, from what the security agent judged. Every branch
 * is an action of the closed set the coordinator already has: a fix or a replacement is scoped, an upstream
 * fix is waited for (the exception ends on its own once the registry lists a patched version, and the next pass
 * resumes the tasks it held), and anything else, or no judgement, goes to a person.
 */
export function securityDecision(exception: { evidence: string; security?: SecurityJudgement }): {
  action: 'scope' | 'wait' | 'escalate'
  reason: string
} {
  const { evidence, security } = exception
  if (!security) {
    return {
      action: 'escalate',
      reason: `${evidence}: no security judgement was made, so a person decides; nothing is ignored`,
    }
  }
  switch (security.action) {
    case 'fix':
      return {
        action: 'scope',
        reason: `${evidence}: a patched version exists, upgrade or override to ${security.version}. ${security.reason}`,
      }
    case 'replace':
      return {
        action: 'scope',
        reason: `${evidence}: remove or replace the dependency. ${security.reason}`,
      }
    case 'wait_upstream':
      return {
        action: 'wait',
        reason: `${evidence}: no patched version of ${security.advisory} is published, the fix is tracked at ${security.tracked}; the tasks it holds wait and resume when the registry lists one`,
      }
    case 'escalate':
      return { action: 'escalate', reason: `${evidence}: ${security.reason}` }
  }
}

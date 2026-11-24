import { en, type Copy } from './copy/en'
import { ACTING, toolNameOf } from './guides'

export type Activity = { looked: string[]; did: string[]; refused: string[] }

const unique = (items: string[]) => [...new Set(items)]

/** What the assistant did in a message besides writing: what it looked at, what it changed, what was refused. */
export function activityOf(
  message: { parts: Record<string, unknown>[] },
  t: Copy['activity'] = en.activity,
): Activity {
  const looked: string[] = []
  const did: string[] = []
  const refused: string[] = []
  for (const part of message.parts) {
    const name = toolNameOf(part)
    if (!name) continue
    if (part.state === 'output-denied' && name in t.changes) refused.push(t.changes[name])
    else if (part.state !== 'output-available') continue
    else if (ACTING.has(name)) did.push(t.changes[name] ?? name)
    else looked.push(t.reads[name] ?? name)
  }
  return { looked: unique(looked), did: unique(did), refused: unique(refused) }
}

/** The message with its tool calls taken out: what they did is told by `activityOf`, in plain words. */
export function withoutTools<M extends { parts: Record<string, unknown>[] }>(message: M): M {
  return { ...message, parts: message.parts.filter((part) => toolNameOf(part) === undefined) }
}

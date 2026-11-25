import { createHash } from 'node:crypto'

import { taskCount, type CuratedNote } from './format'

/** The actions the assistant may answer with, and nothing else. */
export const CURATOR_ACTIONS = ['merge', 'promote', 'keep'] as const
export type CuratorAction = (typeof CURATOR_ACTIONS)[number]

/** The tasks a group must come from before it may become a rule. */
export const PROMOTE_MIN_TASKS = 3

/** The most characters of title and text the assistant may write. */
const TITLE_MAX = 120
const TEXT_MAX = 4_000

export type Group = {
  action: CuratorAction
  notes: CuratedNote[]
  title: string
  text: string
}

export type Answer = { groups: Group[] } | { error: string }

/** The alias an assistant sees a note by. */
export const aliasOf = (index: number) => `n${index + 1}`

/** What identifies a group: its action and the paths of its notes, in any order. */
export function groupKey(action: string, paths: string[]): string {
  return createHash('sha256')
    .update(`${action}\n${[...paths].sort().join('\n')}`)
    .digest('hex')
}

/** The reply as a value: bare JSON, or JSON in one code fence. Anything else is no answer. */
function jsonOf(response: string): unknown {
  const text = response.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text)
  return JSON.parse(fenced ? fenced[1] : text)
}

/**
 * The groups an answer names, checked against the notes it was given: a closed set of actions, notes that
 * exist and appear once, a merge of at least two, a promotion of at least three notes from three tasks, and
 * a text for each. An answer with one bad group is no answer: nothing of it is used.
 */
export function parseAnswer(response: string, notes: CuratedNote[]): Answer {
  let value: unknown
  try {
    value = jsonOf(response)
  } catch {
    return { error: 'the answer is not valid JSON' }
  }
  const groups = (value as { groups?: unknown } | null)?.groups
  if (!Array.isArray(groups)) return { error: 'the answer has no "groups" list' }
  const used = new Set<string>()
  const parsed: Group[] = []
  for (const [i, raw] of groups.entries()) {
    const g = raw as { action?: unknown; notes?: unknown; title?: unknown; text?: unknown } | null
    const where = `group ${i + 1}`
    const action = CURATOR_ACTIONS.find((a) => a === g?.action)
    if (!action) return { error: `${where} names the action ${JSON.stringify(g?.action)}` }
    if (!Array.isArray(g?.notes) || g.notes.length === 0) return { error: `${where} has no notes` }
    const picked: CuratedNote[] = []
    for (const alias of g.notes as unknown[]) {
      const index = notes.findIndex((_, n) => aliasOf(n) === alias)
      if (index === -1) return { error: `${where} names the unknown note ${JSON.stringify(alias)}` }
      if (used.has(aliasOf(index))) return { error: `${where} names ${aliasOf(index)} twice` }
      used.add(aliasOf(index))
      picked.push(notes[index])
    }
    const title = typeof g.title === 'string' ? g.title.trim() : ''
    const text = typeof g.text === 'string' ? g.text.trim() : ''
    if (action !== 'keep') {
      if (!title || title.length > TITLE_MAX) return { error: `${where} has no usable title` }
      if (!text || text.length > TEXT_MAX) return { error: `${where} has no usable text` }
    }
    if (action === 'merge' && picked.length < 2) return { error: `${where} merges fewer than two` }
    if (action === 'promote') {
      if (picked.length < PROMOTE_MIN_TASKS || taskCount(picked) < PROMOTE_MIN_TASKS) {
        return { error: `${where} promotes notes from fewer than ${PROMOTE_MIN_TASKS} tasks` }
      }
    }
    parsed.push({ action, notes: picked, title, text })
  }
  return { groups: parsed }
}

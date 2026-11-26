/** What the owner wrote about one line of a task's change, kept in the browser until it is sent. */
export type ReviewNote = { id: string; path: string; line: number; body: string }

/** The most characters a send-back takes, as the server cuts it. */
export const SEND_BACK_LIMIT = 4000

const OPENING = 'Notes on lines of the change, one per line named:'

const inOrder = (a: ReviewNote, b: ReviewNote) =>
  a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1

/**
 * The text an agent gets for a set of notes: the file, the line in the new version, and the note quoted
 * as JSON, so a note with quotes or line breaks reads the same every time. The same notes give the same
 * text in whatever order they were written.
 */
export function formatNotes(notes: ReviewNote[]): string {
  if (notes.length === 0) return ''
  const blocks = [...notes]
    .sort(inOrder)
    .map((n) => `File: ${n.path}\nLine: ${n.line}\nNote: ${JSON.stringify(n.body)}`)
  return [OPENING, ...blocks].join('\n\n')
}

const key = (taskId: number) => `review-notes:${taskId}`

const isNote = (value: unknown): value is ReviewNote => {
  const n = value as Partial<ReviewNote> | null
  return (
    typeof n?.id === 'string' &&
    typeof n.path === 'string' &&
    typeof n.line === 'number' &&
    typeof n.body === 'string'
  )
}

/** The notes this browser keeps for a task. Storage that is missing or unreadable holds none. */
export function loadNotes(
  taskId: number,
  storage: Storage | undefined = safeStorage(),
): ReviewNote[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(key(taskId)) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter(isNote) : []
  } catch {
    // A private window or a value another version wrote: the owner starts with no notes, and loses nothing sent.
    return []
  }
}

/** Keeps the notes of a task, or forgets them when there are none. Returns whether the browser kept them. */
export function saveNotes(
  taskId: number,
  notes: ReviewNote[],
  storage: Storage | undefined = safeStorage(),
): boolean {
  try {
    if (!storage) return false
    if (notes.length === 0) storage.removeItem(key(taskId))
    else storage.setItem(key(taskId), JSON.stringify(notes))
    return true
  } catch {
    return false
  }
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

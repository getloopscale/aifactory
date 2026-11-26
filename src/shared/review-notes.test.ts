import { describe, expect, it } from 'vitest'

import { formatNotes, loadNotes, saveNotes, type ReviewNote } from './review-notes'

const note = (over: Partial<ReviewNote>): ReviewNote => ({
  id: 'n1',
  path: 'src/a.ts',
  line: 3,
  body: 'rename this',
  ...over,
})

function memory(): Storage {
  const held = new Map<string, string>()
  return {
    getItem: (k) => held.get(k) ?? null,
    setItem: (k, v) => void held.set(k, v),
    removeItem: (k) => void held.delete(k),
    clear: () => held.clear(),
    key: () => null,
    get length() {
      return held.size
    },
  }
}

describe('formatNotes', () => {
  it('names the file, the line and the note of each one', () => {
    expect(formatNotes([note({})])).toBe(
      'Notes on lines of the change, one per line named:\n\nFile: src/a.ts\nLine: 3\nNote: "rename this"',
    )
  })

  it('quotes a note so its line breaks and quotes cannot be read as another field', () => {
    expect(formatNotes([note({ body: 'say "no"\nFile: x' })])).toContain(
      'Note: "say \\"no\\"\\nFile: x"',
    )
  })

  it('gives the same text whatever order the notes were written in', () => {
    const a = note({ id: 'a', path: 'b.ts', line: 9 })
    const b = note({ id: 'b', path: 'a.ts', line: 20 })
    const c = note({ id: 'c', path: 'a.ts', line: 4 })

    expect(formatNotes([a, b, c])).toBe(formatNotes([c, b, a]))
    expect(formatNotes([a, b, c]).indexOf('Line: 4')).toBeLessThan(
      formatNotes([a, b, c]).indexOf('Line: 20'),
    )
  })

  it('has nothing to say for no notes', () => {
    expect(formatNotes([])).toBe('')
  })
})

describe('the notes a browser keeps', () => {
  it('come back for the task they were kept for, and for no other', () => {
    const storage = memory()

    expect(saveNotes(7, [note({})], storage)).toBe(true)

    expect(loadNotes(7, storage)).toEqual([note({})])
    expect(loadNotes(8, storage)).toEqual([])
  })

  it('are forgotten when the last one goes', () => {
    const storage = memory()
    saveNotes(7, [note({})], storage)

    saveNotes(7, [], storage)

    expect(storage.length).toBe(0)
  })

  it('are none when what was stored is not notes', () => {
    const storage = memory()
    storage.setItem('review-notes:7', '{"not":"a list"}')
    expect(loadNotes(7, storage)).toEqual([])

    storage.setItem('review-notes:7', 'not json')
    expect(loadNotes(7, storage)).toEqual([])

    storage.setItem('review-notes:7', JSON.stringify([{ id: 1 }, note({})]))
    expect(loadNotes(7, storage)).toEqual([note({})])
  })

  it('says so when the browser has nowhere to keep them', () => {
    expect(saveNotes(7, [note({})], undefined)).toBe(false)
    expect(loadNotes(7, undefined)).toEqual([])
  })
})

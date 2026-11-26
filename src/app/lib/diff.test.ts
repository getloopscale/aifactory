import { describe, expect, it } from 'vitest'

import { parsePatch } from './diff'

describe('parsePatch', () => {
  it('numbers each line on the side it belongs to', () => {
    const patch = [
      '@@ -10,3 +10,4 @@ function a() {',
      ' keep',
      '-gone',
      '+new',
      '+newer',
      ' end',
    ].join('\n')

    expect(parsePatch(patch)).toEqual([
      { kind: 'meta', text: '@@ -10,3 +10,4 @@ function a() {' },
      { kind: 'context', text: 'keep', oldLine: 10, newLine: 10 },
      { kind: 'del', text: 'gone', oldLine: 11 },
      { kind: 'add', text: 'new', newLine: 11 },
      { kind: 'add', text: 'newer', newLine: 12 },
      { kind: 'context', text: 'end', oldLine: 12, newLine: 13 },
    ])
  })

  it('starts the count again at every hunk', () => {
    const lines = parsePatch(
      ['@@ -1 +1 @@', '-a', '+b', '@@ -40,2 +40,2 @@', ' c', '+d'].join('\n'),
    )

    expect(lines[4]).toEqual({ kind: 'context', text: 'c', oldLine: 40, newLine: 40 })
    expect(lines[5]).toEqual({ kind: 'add', text: 'd', newLine: 41 })
  })

  it("keeps git's marker of a missing final newline out of the count", () => {
    const lines = parsePatch(['@@ -1 +1 @@', '-a', '\\ No newline at end of file', '+b'].join('\n'))

    expect(lines[2]).toEqual({ kind: 'meta', text: '\\ No newline at end of file' })
    expect(lines[3]).toEqual({ kind: 'add', text: 'b', newLine: 1 })
  })

  it('keeps an empty changed line, which is a line of the file', () => {
    expect(parsePatch(['@@ -0,0 +1,2 @@', '+', '+x'].join('\n')).slice(1)).toEqual([
      { kind: 'add', text: '', newLine: 1 },
      { kind: 'add', text: 'x', newLine: 2 },
    ])
  })

  it('numbers nothing before the first hunk header', () => {
    expect(parsePatch('+stray')).toEqual([{ kind: 'meta', text: '+stray' }])
  })
})

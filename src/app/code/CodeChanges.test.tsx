// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { CodeDiff, CodeDiffLine } from '../../shared/code'
import { CopyProvider } from '../lib/copy'
import { en } from '../lib/copy/en'

import { CodeChanges, foldHunk } from './CodeChanges'

afterEach(cleanup)

const ctx = (n: number): CodeDiffLine => ({
  kind: 'context',
  text: `c${n}`,
  oldLine: n,
  newLine: n,
})
const diff: CodeDiff = {
  files: [
    {
      path: 'src/a.ts',
      added: 1,
      removed: 1,
      binary: false,
      hunks: [
        {
          header: '@@ -1,3 +1,3 @@',
          lines: [
            ctx(1),
            { kind: 'del', text: 'old', oldLine: 2 },
            { kind: 'add', text: 'fresh line', newLine: 2 },
          ],
        },
      ],
    },
    {
      path: 'b.md',
      added: 2,
      removed: 0,
      binary: false,
      hunks: [
        {
          header: '@@ -1,10 +1,10 @@',
          lines: [
            { kind: 'add', text: 'top', newLine: 1 },
            ...Array.from({ length: 8 }, (_, i) => ctx(i + 2)),
            { kind: 'add', text: 'end', newLine: 10 },
          ],
        },
      ],
    },
  ],
}

const show = (d: CodeDiff) =>
  render(
    <CopyProvider>
      <CodeChanges diff={d} />
    </CopyProvider>,
  )

describe('CodeChanges', () => {
  it('lists the files with their counts, closed', () => {
    show(diff)
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText('src/a.ts')).toBeDefined()
    expect(screen.getByText('+1 −1')).toBeDefined()
    expect(screen.getByText('+2 −0')).toBeDefined()
    expect(screen.queryByText('fresh line')).toBeNull()
  })

  it('opens a file to its added lines with the numbers of both sides', () => {
    show(diff)
    fireEvent.click(screen.getByRole('button', { name: en.code.changes.open('src/a.ts') }))
    const region = screen.getByRole('region', { name: en.code.changes.diffOf('src/a.ts') })
    const added = within(region).getByText('+fresh line').closest('[data-line]')!
    expect(added.getAttribute('data-line')).toBe('add')
    expect(added.textContent).toBe('2+fresh line')
    const removed = within(region).getByText('-old').closest('[data-line]')!
    expect(removed.textContent).toBe('2-old')
    expect(within(region).getByText('c1').closest('[data-line]')!.textContent).toBe('11 c1')
  })

  it('folds a long unchanged run and shows it on a click', () => {
    show(diff)
    fireEvent.click(screen.getByRole('button', { name: en.code.changes.open('b.md') }))
    expect(screen.queryByText('c5')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.code.changes.unchanged(8) }))
    expect(screen.getByText('c5')).toBeDefined()
  })

  it('reads "No changes yet" for an empty diff', () => {
    show({ files: [] })
    expect(screen.getByText('No changes yet')).toBeDefined()
  })

  it('keeps a short run of context and folds only the long ones', () => {
    const pieces = foldHunk([ctx(1), ctx(2), { kind: 'add', text: 'x', newLine: 3 }])
    expect(pieces.map((p) => p.fold)).toEqual([false, false, false])
    expect(foldHunk(Array.from({ length: 7 }, (_, i) => ctx(i)))).toHaveLength(1)
  })
})

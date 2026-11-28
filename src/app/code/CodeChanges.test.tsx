// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CodeDiff, CodeDiffLine } from '../../shared/code'
import { CopyProvider } from '../lib/copy'
import { en } from '../lib/copy/en'

vi.mock('../lib/api', () => ({ post: vi.fn() }))
vi.mock('../components/Assist', () => ({
  Assist: ({ kind }: { kind: string }) => <p>assist {kind}</p>,
}))

import { post } from '../lib/api'

import { CodeChanges, foldHunk, PullRequestForm } from './CodeChanges'

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

describe('the pull request form', () => {
  const form = (props: Partial<Parameters<typeof PullRequestForm>[0]> = {}) =>
    render(
      <CopyProvider>
        <PullRequestForm sessionId="s 1" repository="acme/app" hasChanges {...props} />
      </CopyProvider>,
    )
  const copy = en.code.changes.pullRequest

  it('offers an assistant for the title and for the body', () => {
    form()
    expect(screen.getAllByText(/^assist /)).toHaveLength(2)
  })

  it('sends the title and the body, then shows the link', async () => {
    vi.mocked(post).mockResolvedValue({ number: 7, url: 'https://github.com/acme/app/pull/7' })
    form()
    expect((screen.getByRole('button', { name: copy.open }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    fireEvent.change(screen.getByLabelText(copy.title), { target: { value: ' Add a ' } })
    fireEvent.change(screen.getByLabelText(copy.body), { target: { value: 'Why' } })
    fireEvent.click(screen.getByRole('button', { name: copy.open }))
    const link = await screen.findByRole('link', { name: copy.link(7) })
    expect(link.getAttribute('href')).toBe('https://github.com/acme/app/pull/7')
    expect(post).toHaveBeenCalledWith('/api/panel/code/sessions/s%201/pull-request', {
      title: 'Add a',
      body: 'Why',
    })
  })

  it('says why it failed and keeps what was typed', async () => {
    vi.mocked(post).mockRejectedValue(new Error('The work changes .github/workflows/ci.yml'))
    form()
    fireEvent.change(screen.getByLabelText(copy.title), { target: { value: 'T' } })
    fireEvent.click(screen.getByRole('button', { name: copy.open }))
    expect((await screen.findByRole('alert')).textContent).toContain('ci.yml')
    expect((screen.getByLabelText(copy.title) as HTMLInputElement).value).toBe('T')
  })

  it('shows the link of a pull request opened before, and cannot send with no change', () => {
    form({ existing: { number: 3, url: 'https://github.com/acme/app/pull/3' }, hasChanges: false })
    expect(screen.getByRole('link', { name: copy.link(3) })).toBeDefined()
    expect((screen.getByRole('button', { name: copy.again }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect(screen.getByText(copy.noChanges)).toBeDefined()
  })

  it('says why opening is off with no title', () => {
    form()
    expect(screen.getByText(copy.noTitle)).toBeDefined()
    expect(screen.getByLabelText(copy.title)).toBeDefined()
  })

  describe('with a pull request opened before', () => {
    const existing = { number: 69, url: 'https://github.com/acme/app/pull/69' }

    it('names the title field as the commit message and says why the button is off', () => {
      form({ existing })
      expect(screen.getByLabelText(copy.commitTitle)).toBeDefined()
      expect(screen.queryByLabelText(copy.title)).toBeNull()
      expect((screen.getByRole('button', { name: copy.again }) as HTMLButtonElement).disabled).toBe(
        true,
      )
      expect(screen.getByText(copy.noCommitTitle)).toBeDefined()
      fireEvent.change(screen.getByLabelText(copy.commitTitle), { target: { value: 'Fix' } })
      expect(screen.queryByText(copy.noCommitTitle)).toBeNull()
    })

    it('confirms the send with a link to the pull request', async () => {
      vi.mocked(post).mockResolvedValue(existing)
      form({ existing })
      fireEvent.change(screen.getByLabelText(copy.commitTitle), {
        target: { value: 'validate clamp arguments' },
      })
      fireEvent.click(screen.getByRole('button', { name: copy.again }))
      const status = await screen.findByRole('status')
      expect(status.textContent).toContain(copy.sent(69))
      expect(within(status).getByRole('link').getAttribute('href')).toBe(existing.url)
    })

    it('confirms nothing when the send fails, and keeps what was typed', async () => {
      vi.mocked(post).mockRejectedValue(new Error('push refused'))
      form({ existing })
      fireEvent.change(screen.getByLabelText(copy.commitTitle), { target: { value: 'T' } })
      fireEvent.click(screen.getByRole('button', { name: copy.again }))
      expect((await screen.findByRole('alert')).textContent).toContain('push refused')
      expect(screen.queryByRole('status')).toBeNull()
      expect((screen.getByLabelText(copy.commitTitle) as HTMLInputElement).value).toBe('T')
    })
  })

  it('confirms nothing on opening the first pull request', async () => {
    vi.mocked(post).mockResolvedValue({ number: 7, url: 'https://github.com/acme/app/pull/7' })
    form()
    fireEvent.change(screen.getByLabelText(copy.title), { target: { value: 'T' } })
    fireEvent.click(screen.getByRole('button', { name: copy.open }))
    await screen.findByRole('link', { name: copy.link(7) })
    expect(screen.queryByRole('status')).toBeNull()
  })
})

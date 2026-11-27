// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { en } from '../lib/copy/en'

vi.mock('../lib/api', () => ({ get: vi.fn() }))

import { get } from '../lib/api'

import { CodeFiles, filterFiles } from './CodeFiles'

afterEach(cleanup)

const files = ['README.md', 'src/app.ts', 'src/lib/util.ts']
const f = en.code.files

describe('the files tab', () => {
  it('narrows the tree to the files that match the filter', () => {
    render(
      <CodeFiles
        sessionId="s"
        files={files}
        error={undefined}
        selected={undefined}
        onSelect={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: 'README.md' })).toBeDefined()
    fireEvent.change(screen.getByLabelText(f.filter), { target: { value: 'util' } })
    expect(screen.getByRole('button', { name: 'util.ts' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'README.md' })).toBeNull()
    fireEvent.change(screen.getByLabelText(f.filter), { target: { value: 'zzz' } })
    expect(screen.getByText(f.noMatch)).toBeDefined()
    expect(filterFiles(files, ' APP ')).toEqual(['src/app.ts'])
  })

  it('opens folders and picks a file', () => {
    const onSelect = vi.fn()
    render(
      <CodeFiles
        sessionId="s"
        files={files}
        error={undefined}
        selected={undefined}
        onSelect={onSelect}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'src' }))
    expect(screen.queryByRole('button', { name: 'app.ts' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'src' }))
    fireEvent.click(screen.getByRole('button', { name: 'app.ts' }))
    expect(onSelect).toHaveBeenCalledWith('src/app.ts')
  })

  it('shows the text with line numbers and says when it was cut', async () => {
    vi.mocked(get).mockResolvedValue({
      path: 'a.txt',
      content: 'one\ntwo\n',
      truncated: true,
      limit: 10,
    })
    render(
      <CodeFiles
        sessionId="s"
        files={['a.txt']}
        error={undefined}
        selected="a.txt"
        onSelect={() => {}}
      />,
    )
    expect(await screen.findByText('two')).toBeDefined()
    expect(get).toHaveBeenCalledWith('/api/panel/code/sessions/s/file?path=a.txt')
    expect(screen.getByText('2')).toBeDefined()
    expect(screen.getByText(f.truncated(10))).toBeDefined()
  })

  it('shows why a file could not be read', async () => {
    vi.mocked(get).mockRejectedValue(new Error('gone'))
    render(
      <CodeFiles
        sessionId="s"
        files={['a.txt']}
        error={undefined}
        selected="a.txt"
        onSelect={() => {}}
      />,
    )
    expect((await screen.findByRole('alert')).textContent).toBe('gone')
  })
})

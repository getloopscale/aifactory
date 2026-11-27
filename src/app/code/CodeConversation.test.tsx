// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CodeEventWire, CodeSessionWire, CodeState } from '../../shared/code'
import { en } from '../lib/copy/en'

vi.mock('../lib/api', () => ({ post: vi.fn(), patch: vi.fn() }))
vi.mock('../components/Assist', () => ({ Assist: () => <p>assist</p> }))
vi.mock('@getloopscale/loopzero-ui', () => ({
  ChatMessageResponse: ({ text }: { text: string }) => <div data-testid="md">{text}</div>,
}))

import { patch, post } from '../lib/api'

import { CodeConversation, linkPaths, mentionAt } from './CodeConversation'

const c = en.code.conversation

const session = (state: CodeState): CodeSessionWire => ({
  id: 's1',
  title: 'T',
  repository: 'acme/shop',
  baseBranch: 'workspace',
  workBranch: 'code/s1',
  harness: 'codex',
  model: null,
  mode: 'code',
  state,
  sandboxId: null,
  snapshotId: null,
  agentSessionId: null,
  agentSessionHarness: null,
  createdAt: '',
  updatedAt: '',
})
const ev = (
  seq: number,
  kind: CodeEventWire['kind'],
  content: string,
  tool: string | null = null,
): CodeEventWire => ({ sessionId: 's1', seq, kind, tool, content, at: '' })

beforeEach(() => {
  vi.mocked(post).mockReset()
  vi.mocked(patch).mockReset()
})
afterEach(cleanup)

describe('the conversation', () => {
  it('folds two tool pairs into one line that opens on both commands', () => {
    render(
      <CodeConversation
        session={session('idle')}
        events={[
          ev(1, 'user_message', 'run the tests'),
          ev(2, 'tool_use', 'ls -la', 'bash'),
          ev(3, 'tool_result', 'file-a', 'bash'),
          ev(4, 'tool_use', 'pnpm test', 'bash'),
          ev(5, 'tool_result', 'all green', 'bash'),
          ev(6, 'agent_message', 'Done **now**'),
        ]}
      />,
    )
    expect(screen.getByText('run the tests')).toBeDefined()
    expect(screen.getByTestId('md').textContent).toBe('Done **now**')
    expect(screen.queryByText('ls -la')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: c.ranCommands(2) }))
    expect(screen.getByText('ls -la')).toBeDefined()
    expect(screen.getByText('pnpm test')).toBeDefined()
    fireEvent.click(screen.getAllByRole('button', { name: /bash/ })[1]!)
    expect(screen.getByText('all green')).toBeDefined()
  })

  it('marks a failed result with a dot and shows its output', () => {
    render(
      <CodeConversation
        session={session('idle')}
        events={[ev(1, 'tool_use', 'make', 'bash'), ev(2, 'error', 'boom')]}
      />,
    )
    const card = screen.getByRole('button', { name: /bash/ })
    const dot = screen.getByRole('img', { name: c.failed })
    expect(dot.className).toContain('bg-destructive')
    expect(dot.textContent).toBe('')
    fireEvent.click(card)
    const out = screen.getByText('boom')
    expect(out.className).not.toContain('destructive')
  })

  it('reads an edit with and without line counts', () => {
    render(
      <CodeConversation
        session={session('idle')}
        events={[
          ev(1, 'tool_use', JSON.stringify({ file_path: 'a.ts', added: 3, removed: 1 }), 'edit'),
          ev(2, 'tool_result', 'ok'),
          ev(3, 'agent_message', 'between'),
          ev(4, 'tool_use', JSON.stringify({ file_path: 'b.ts' }), 'edit'),
          ev(5, 'tool_result', 'ok'),
        ]}
      />,
    )
    expect(screen.getByText(`${c.edited} a.ts`)).toBeDefined()
    expect(screen.getByText(c.lines(3, 1))).toBeDefined()
    expect(screen.getByText(`${c.edited} b.ts`)).toBeDefined()
    expect(screen.queryByText(c.lines(0, 0))).toBeNull()
  })

  it('keeps an edit on a line of its own between folded commands', () => {
    render(
      <CodeConversation
        session={session('idle')}
        events={[
          ev(1, 'tool_use', 'ls', 'bash'),
          ev(2, 'tool_result', 'a'),
          ev(3, 'tool_use', 'cat a', 'bash'),
          ev(4, 'tool_result', 'b'),
          ev(5, 'tool_use', JSON.stringify({ file_path: 'a.ts', added: 1, removed: 0 }), 'edit'),
          ev(6, 'tool_result', 'ok'),
        ]}
      />,
    )
    expect(screen.getByRole('button', { name: c.ranCommands(2) })).toBeDefined()
    expect(screen.getByText(`${c.edited} a.ts`)).toBeDefined()
  })

  it('names the agent and the model of the session under the box', () => {
    render(<CodeConversation session={{ ...session('idle'), model: 'm-1' }} events={[]} />)
    expect(screen.getByLabelText(`${c.by}: codex · m-1`)).toBeDefined()
  })

  it('shows the working line and a disabled send while running', () => {
    render(<CodeConversation session={session('running')} events={[]} />)
    expect(screen.getByRole('status').textContent).toBe(c.stateLine.running)
    expect(screen.getByPlaceholderText(c.refused.running)).toBeDefined()
    expect((screen.getByRole('button', { name: c.send }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText(c.message) as HTMLTextAreaElement).disabled).toBe(true)
  })

  it('sends on Enter and keeps the draft when the request fails', async () => {
    vi.mocked(post).mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce({})
    render(<CodeConversation session={session('idle')} events={[]} />)
    const box = screen.getByLabelText(c.message) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'go' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await screen.findByRole('alert')
    expect(box.value).toBe('go')
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(box.value).toBe(''))
    expect(post).toHaveBeenLastCalledWith('/api/panel/code/sessions/s1/messages', {
      text: 'go',
    })
  })
})

describe('following the end', () => {
  it('keeps the end in view, and stops after a scroll up', () => {
    const geometry = { scrollHeight: 1000, clientHeight: 200 }
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => geometry.scrollHeight,
    })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => geometry.clientHeight,
    })
    const first = [ev(1, 'user_message', 'one')]
    const { rerender, container } = render(
      <CodeConversation session={session('idle')} events={first} />,
    )
    const box = container.querySelector('.\\[overflow-anchor\\:none\\]') as HTMLElement
    expect(box.scrollTop).toBe(1000)
    geometry.scrollHeight = 1200
    rerender(
      <CodeConversation
        session={session('idle')}
        events={[...first, ev(2, 'agent_message', 'two')]}
      />,
    )
    expect(box.scrollTop).toBe(1200)
    box.scrollTop = 100
    fireEvent.scroll(box)
    geometry.scrollHeight = 1400
    rerender(
      <CodeConversation
        session={session('idle')}
        events={[...first, ev(2, 'agent_message', 'two'), ev(3, 'agent_message', 'three')]}
      />,
    )
    expect(box.scrollTop).toBe(100)
  })

  it('shows the three modes with a line each, and picking Plan saves it', async () => {
    vi.mocked(patch).mockResolvedValueOnce({ mode: 'plan' })
    render(<CodeConversation session={session('idle')} events={[]} />)
    fireEvent.click(screen.getByRole('button', { name: c.modeLabel }))
    for (const m of ['ask', 'plan', 'code'] as const)
      expect(screen.getByText(c.modeAbout[m])).toBeDefined()
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(en.code.modes.plan) }))
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/api/panel/code/sessions/s1', { mode: 'plan' }),
    )
    await screen.findByText(`${c.modeLabel}: ${en.code.modes.plan}`)
  })

  it('picks Code with the key 3 while the selector is open, and ignores it closed', async () => {
    vi.mocked(patch).mockResolvedValueOnce({ mode: 'code' })
    render(<CodeConversation session={{ ...session('idle'), mode: 'ask' }} events={[]} />)
    fireEvent.keyDown(window, { key: '3' })
    expect(patch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: c.modeLabel }))
    fireEvent.keyDown(window, { key: '3' })
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/api/panel/code/sessions/s1', { mode: 'code' }),
    )
  })

  it('says so when the mode cannot be saved and keeps the old one', async () => {
    vi.mocked(patch).mockRejectedValueOnce(new Error('down'))
    render(<CodeConversation session={session('idle')} events={[]} />)
    fireEvent.click(screen.getByRole('button', { name: c.modeLabel }))
    fireEvent.keyDown(window, { key: '1' })
    await screen.findByRole('alert')
    expect(screen.getByText(`${c.modeLabel}: ${en.code.modes.code}`)).toBeDefined()
  })
})

describe('mentioning a file', () => {
  const files = ['README.md', 'src/readme-helper.ts', 'src/app.ts']

  it('lists matching files after @ and leaves the path in the box on Enter, sending nothing', () => {
    render(<CodeConversation session={session('idle')} events={[]} files={files} />)
    const box = screen.getByLabelText(c.message) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: '@rea', selectionStart: 4 } })
    const options = screen.getAllByRole('option').map((o) => o.textContent)
    expect(options).toEqual(['README.md', 'src/readme-helper.ts'])
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(box.value).toBe('@README.md')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(post).not.toHaveBeenCalled()
  })

  it('moves with the arrows, closes on Escape and takes a click', () => {
    render(<CodeConversation session={session('idle')} events={[]} files={files} />)
    const box = screen.getByLabelText(c.message) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'see @rea', selectionStart: 8 } })
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(box.value).toBe('see @src/readme-helper.ts')
    fireEvent.change(box, { target: { value: 'see @rea', selectionStart: 8 } })
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.change(box, { target: { value: 'see @app', selectionStart: 8 } })
    fireEvent.mouseDown(screen.getByRole('option', { name: 'src/app.ts' }))
    expect(box.value).toBe('see @src/app.ts')
  })

  it('sends the path in the text', async () => {
    vi.mocked(post).mockResolvedValue({})
    render(<CodeConversation session={session('idle')} events={[]} files={files} />)
    const box = screen.getByLabelText(c.message)
    fireEvent.change(box, { target: { value: 'read @rea', selectionStart: 9 } })
    fireEvent.keyDown(box, { key: 'Enter' })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/panel/code/sessions/s1/messages', {
        text: 'read @README.md',
      }),
    )
  })

  it('finds the mention that ends at the caret', () => {
    expect(mentionAt('a @b', 4)).toEqual({ query: 'b', start: 2 })
    expect(mentionAt('mail a@b', 8)).toBeUndefined()
    expect(mentionAt('@b c', 4)).toBeUndefined()
  })
})

describe('linkPaths', () => {
  const files = ['README.md', 'src/app.ts', 'Makefile']
  it('links known paths, bare or in code, and nothing else', () => {
    const out = linkPaths('Edit src/app.ts, `README.md`. See other/app.ts and Makefile.', files)
    expect(out).toContain('[src/app.ts](#workspace-file/src%2Fapp.ts),')
    expect(out).toContain('[`README.md`](#workspace-file/README.md).')
    expect(out).toContain('other/app.ts')
    expect(out).not.toContain('](#workspace-file/other')
    expect(out).not.toContain('Makefile](')
  })
  it('leaves code fences alone', () => {
    const text = '```\nsrc/app.ts\n```'
    expect(linkPaths(text, files)).toBe(text)
  })
})

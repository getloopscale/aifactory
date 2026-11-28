// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  WAITING_FOR_WORKSPACE,
  type CodeEventWire,
  type CodeSessionWire,
  type CodeState,
} from '../../shared/code'
import { acceptedPlanMessage } from '../../server/agents/prompts/code-plan'
import { CopyProvider } from '../lib/copy'
import { en } from '../lib/copy/en'
import { ptBR } from '../lib/copy/pt-BR'

vi.mock('../lib/api', () => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() }))
vi.mock('../components/Assist', () => ({
  Assist: ({ context }: { context?: string }) => (
    <p data-testid="assist" data-context={context}>
      assist
    </p>
  ),
}))
vi.mock('@getloopscale/loopzero-ui', () => ({
  ChatMessageResponse: ({ text }: { text: string }) => <div data-testid="md">{text}</div>,
}))

import { del, get, patch, post } from '../lib/api'

import {
  CodeConversation,
  CONTEXT_PATHS,
  linkPaths,
  mentionAt,
  PLAN_CONTEXT_CHARS,
} from './CodeConversation'

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
  vi.mocked(del).mockReset()
  vi.mocked(get).mockReset()
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

  it('shows a failed turn once, as an error, and never as commands', () => {
    const text = "There's an issue with the selected model (modelo-que-nao-existe)."
    render(
      <CodeConversation
        session={session('failed')}
        events={[
          ev(1, 'user_message', 'hi'),
          ev(2, 'agent_message', text),
          ev(3, 'error', text),
          ev(4, 'error', text),
        ]}
      />,
    )
    expect(screen.getAllByText(text)).toHaveLength(1)
    expect(screen.getByRole('group', { name: c.error }).textContent).toContain(text)
    expect(screen.queryByText(c.ranCommands(2))).toBeNull()
    expect(screen.queryByTestId('md')).toBeNull()
  })

  it('keeps distinct errors, an agent message that differs, and the same error of another turn', () => {
    render(
      <CodeConversation
        session={session('idle')}
        events={[
          ev(1, 'user_message', 'one'),
          ev(2, 'agent_message', 'tried'),
          ev(3, 'error', 'first'),
          ev(4, 'error', 'second'),
          ev(5, 'user_message', 'two'),
          ev(6, 'error', 'first'),
        ]}
      />,
    )
    expect(screen.getByTestId('md').textContent).toBe('tried')
    expect(screen.getAllByRole('group', { name: c.error })).toHaveLength(3)
    expect(screen.getAllByText('first')).toHaveLength(2)
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

  it('says a turn waits for a workspace until its turn starts', () => {
    const waiting = [
      ev(1, 'user_message', 'hi'),
      ev(2, 'state', WAITING_FOR_WORKSPACE, 'code'),
      ev(3, 'state', WAITING_FOR_WORKSPACE, 'code'),
    ]
    const { rerender } = render(<CodeConversation session={session('queued')} events={waiting} />)
    expect(screen.getByRole('status').textContent).toBe(c.waitingWorkspace)
    rerender(<CodeConversation session={session('starting')} events={waiting} />)
    expect(screen.getByRole('status').textContent).toBe(c.waitingWorkspace)
    rerender(
      <CodeConversation
        session={session('running')}
        events={[...waiting, ev(4, 'state', 'turn:1', 'code')]}
      />,
    )
    expect(screen.getByRole('status').textContent).toBe(c.stateLine.running)
    rerender(
      <CodeConversation session={session('starting')} events={[ev(1, 'user_message', 'hi')]} />,
    )
    expect(screen.getByRole('status').textContent).toBe(c.stateLine.starting)
  })

  it('says a checkout of a missing base branch in the owner words, and keeps any other error', () => {
    const missing =
      "repo_provision_failed [work] checkout branch-que-nao-existe failed: error: pathspec 'branch-que-nao-existe' did not match any file(s) known to git"
    render(
      <CodeConversation
        session={session('failed')}
        events={[
          ev(1, 'user_message', 'hi'),
          ev(2, 'state', 'turn:1'),
          ev(3, 'error', missing),
          ev(4, 'user_message', 'again'),
          ev(5, 'error', 'repo_provision_failed [work] clone failed: timeout'),
        ]}
      />,
    )
    const said = c.missingBranch('branch-que-nao-existe', 'acme/shop')
    expect(said).toBe(
      'The branch branch-que-nao-existe does not exist in acme/shop. Start a session on a branch the repository has.',
    )
    expect(screen.getByText(said)).toBeDefined()
    expect(screen.queryByText(missing)).toBeNull()
    expect(screen.getByText('repo_provision_failed [work] clone failed: timeout')).toBeDefined()
  })

  it('shows Stop in place of Send only while running with an empty box', async () => {
    vi.mocked(post).mockResolvedValue({})
    const { rerender } = render(<CodeConversation session={session('running')} events={[]} />)
    expect(screen.getByRole('status').textContent).toBe(c.stateLine.running)
    expect(screen.queryByRole('button', { name: c.send })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: c.stop }))
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/panel/code/sessions/s1/stop', {}))
    rerender(<CodeConversation session={session('idle')} events={[]} />)
    expect(screen.queryByRole('button', { name: c.stop })).toBeNull()
    expect(screen.getByRole('button', { name: c.send })).toBeDefined()
  })

  it('sends a typed message to a running turn', async () => {
    vi.mocked(post).mockResolvedValue({})
    render(<CodeConversation session={session('running')} events={[]} />)
    fireEvent.change(screen.getByLabelText(c.message), { target: { value: 'also this' } })
    expect(screen.queryByRole('button', { name: c.stop })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: c.send }))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/panel/code/sessions/s1/messages', {
        text: 'also this',
      }),
    )
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

describe('a plan', () => {
  const plans = [
    ev(1, 'user_message', 'plan it'),
    ev(2, 'plan', '## What exists\nold'),
    ev(3, 'state', 'plan:2:reject'),
    ev(4, 'user_message', 'again'),
    ev(5, 'plan', '## What exists\nnew'),
  ]

  it('shows the three buttons on the last plan only', () => {
    render(<CodeConversation session={session('waiting_input')} events={plans} />)
    expect(screen.getAllByText(c.plan.title)).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: c.plan.accept })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: c.plan.revise })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: c.plan.reject })).toHaveLength(1)
    expect(screen.getByText(c.plan.answered.reject)).toBeTruthy()
  })

  it('shows no button once the last plan is answered', () => {
    render(
      <CodeConversation
        session={session('queued')}
        events={[...plans, ev(6, 'state', 'plan:5:accept')]}
      />,
    )
    expect(screen.queryByRole('button', { name: c.plan.accept })).toBeNull()
  })

  describe('once accepted', () => {
    const plan = '## O que existe\nsrc/app.ts'
    const accepted = [
      ev(1, 'user_message', 'planeje'),
      ev(2, 'plan', plan),
      ev(3, 'state', 'plan:2:accept'),
      ev(4, 'user_message', acceptedPlanMessage(plan)),
      ev(5, 'error', 'boom'),
      ev(6, 'agent_message', 'boom'),
      ev(7, 'user_message', 'and now the tests'),
    ]
    const shown = () => document.body.textContent ?? ''

    it('holds the plan once, the acceptance once, and none of the instruction', () => {
      render(<CodeConversation session={session('running')} events={accepted} />)
      expect(shown().split('src/app.ts')).toHaveLength(2)
      expect(shown()).not.toContain('Carry it out')
      expect(shown()).not.toContain('accepted')
      expect(screen.getAllByText(c.plan.answered.accept)).toHaveLength(1)
      expect(screen.getByText('and now the tests')).toBeTruthy()
    })

    it('says it in Portuguese on a page in Portuguese', () => {
      window.localStorage.setItem('aifactory.language', 'pt-BR')
      try {
        render(
          <CopyProvider>
            <CodeConversation session={session('running')} events={accepted} />
          </CopyProvider>,
        )
      } finally {
        window.localStorage.clear()
      }
      expect(screen.getAllByText(ptBR.code.conversation.plan.answered.accept)).toHaveLength(1)
      expect(shown()).not.toContain('Carry it out')
    })

    it('still starts a turn with the instruction, so its error is shown once and not repeated', () => {
      render(<CodeConversation session={session('running')} events={accepted} />)
      expect(screen.getAllByText('boom')).toHaveLength(1)
    })

    it('keeps the text of a revision as the owner wrote it', () => {
      render(
        <CodeConversation
          session={session('queued')}
          events={[
            ...accepted.slice(0, 2),
            ev(3, 'state', 'plan:2:revise'),
            ev(4, 'user_message', 'mais curto'),
          ]}
        />,
      )
      expect(screen.getByText('mais curto')).toBeTruthy()
    })
  })

  it('accepts the plan by its sequence number', async () => {
    vi.mocked(post).mockResolvedValue({})
    render(<CodeConversation session={session('waiting_input')} events={plans} />)
    fireEvent.click(screen.getByRole('button', { name: c.plan.accept }))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/panel/code/sessions/s1/plan-answer', {
        plan: 5,
        answer: 'accept',
      }),
    )
  })

  it('puts the focus in the revision box once Revise opens it', () => {
    render(<CodeConversation session={session('waiting_input')} events={plans} />)
    fireEvent.click(screen.getByRole('button', { name: c.plan.revise }))
    expect(document.activeElement).toBe(screen.getByLabelText(c.plan.reviseLabel))
  })

  it('sends the typed text as the revision', async () => {
    vi.mocked(post).mockResolvedValue({})
    render(<CodeConversation session={session('waiting_input')} events={plans} />)
    fireEvent.click(screen.getByRole('button', { name: c.plan.revise }))
    fireEvent.change(screen.getByLabelText(c.plan.reviseLabel), {
      target: { value: ' add tests ' },
    })
    fireEvent.click(screen.getByRole('button', { name: c.plan.sendRevision }))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/panel/code/sessions/s1/plan-answer', {
        plan: 5,
        answer: 'revise',
        text: 'add tests',
      }),
    )
  })
})

describe('slash commands', () => {
  const type = (value: string) => {
    const box = screen.getByLabelText(c.message)
    fireEvent.change(box, { target: { value } })
    return box as HTMLTextAreaElement
  }

  it('selects /plan on /pl, and Enter saves the mode and clears the box', async () => {
    vi.mocked(patch).mockResolvedValueOnce({ mode: 'plan' })
    render(<CodeConversation session={session('idle')} events={[]} />)
    const box = type('/pl')
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]!.getAttribute('aria-selected')).toBe('true')
    expect(options[0]!.textContent).toContain(c.commands.about.plan)
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(box.value).toBe('')
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/api/panel/code/sessions/s1', { mode: 'plan' }),
    )
    expect(post).not.toHaveBeenCalled()
  })

  it('moves with the arrows and closes on Escape without sending', () => {
    render(<CodeConversation session={session('idle')} events={[]} />)
    const box = type('/')
    const selected = () =>
      screen.getAllByRole('option').findIndex((o) => o.getAttribute('aria-selected') === 'true')
    expect(selected()).toBe(0)
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(selected()).toBe(1)
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    expect(selected()).toBe(screen.getAllByRole('option').length - 1)
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(screen.queryByRole('option')).toBeNull()
    expect(box.value).toBe('/')
    expect(post).not.toHaveBeenCalled()
  })

  it('sets ask through the same handler, and refuses the mode it is already in', async () => {
    vi.mocked(patch).mockResolvedValue({ mode: 'ask' })
    render(<CodeConversation session={session('idle')} events={[]} />)
    let box = type('/code')
    expect(screen.getByRole('option').getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('option').textContent).toContain(c.commands.reasons.sameMode)
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(patch).not.toHaveBeenCalled()
    expect(box.value).toBe('/code')
    box = type('/ask')
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/api/panel/code/sessions/s1', { mode: 'ask' }),
    )
  })

  it('lists /stop disabled with its reason while no turn runs, and runs it while one does', async () => {
    vi.mocked(post).mockResolvedValue({})
    const { rerender } = render(<CodeConversation session={session('idle')} events={[]} />)
    let box = type('/stop')
    expect(screen.getByRole('option').getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('option').textContent).toContain(c.commands.reasons.notRunning)
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(post).not.toHaveBeenCalled()
    rerender(<CodeConversation session={session('running')} events={[]} />)
    box = screen.getByLabelText(c.message) as HTMLTextAreaElement
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/panel/code/sessions/s1/stop', {}))
  })

  const agents = (engines: Record<string, { id: string; label: string }[]>) => ({
    settings: {
      engines: Object.fromEntries(
        Object.entries(engines).map(([k, models]) => [k, { models, efforts: [] }]),
      ),
    },
  })

  it('offers only the models the session harness lists, and the default', async () => {
    vi.mocked(get).mockResolvedValue(
      agents({
        codex: [{ id: 'gpt-x', label: 'GPT X' }],
        'claude-code': [{ id: 'opus', label: 'Opus' }],
      }),
    )
    vi.mocked(patch).mockResolvedValue({ mode: 'code' })
    render(<CodeConversation session={{ ...session('idle'), model: 'gone' }} events={[]} />)
    fireEvent.keyDown(type('/model'), { key: 'Enter' })
    await waitFor(() => expect(screen.getByRole('option', { name: 'GPT X' })).toBeTruthy())
    expect(get).toHaveBeenCalledWith('/api/panel/agents')
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      c.commands.modelDefault,
      'GPT X',
    ])
    expect((screen.getByLabelText(c.commands.model) as HTMLSelectElement).value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: c.commands.save }))
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/api/panel/code/sessions/s1', { model: null }),
    )
  })

  it('says so when the harness lists no model', async () => {
    vi.mocked(get).mockResolvedValue(agents({ codex: [] }))
    render(<CodeConversation session={session('idle')} events={[]} />)
    fireEvent.keyDown(type('/model'), { key: 'Enter' })
    await waitFor(() => expect(screen.getByText(c.commands.noModels)).toBeTruthy())
    expect(screen.getAllByRole('option')).toHaveLength(1)
  })

  it('names the model and rename inputs for a screen reader', async () => {
    vi.mocked(get).mockResolvedValue(agents({ codex: [{ id: 'gpt-x', label: 'GPT X' }] }))
    render(<CodeConversation session={session('idle')} events={[]} />)
    fireEvent.keyDown(type('/model'), { key: 'Enter' })
    const model = screen.getByRole('combobox', { name: c.commands.inputLabel.model })
    expect(model.getAttribute('aria-label')).toBe(c.commands.inputLabel.model)
    fireEvent.click(screen.getByRole('button', { name: c.commands.cancel }))
    fireEvent.keyDown(type('/rename'), { key: 'Enter' })
    const rename = screen.getByRole('textbox', { name: c.commands.inputLabel.rename })
    expect(rename.getAttribute('aria-label')).toBe(c.commands.inputLabel.rename)
  })

  it('opens the model and rename editors and saves them', async () => {
    vi.mocked(get).mockResolvedValue(agents({ codex: [{ id: 'gpt-x', label: 'GPT X' }] }))
    vi.mocked(patch).mockResolvedValue({ title: 'New', mode: 'code' })
    const onRenamed = vi.fn()
    render(<CodeConversation session={session('idle')} events={[]} onRenamed={onRenamed} />)
    fireEvent.keyDown(type('/model'), { key: 'Enter' })
    await waitFor(() => expect(screen.getByRole('option', { name: 'GPT X' })).toBeTruthy())
    fireEvent.change(screen.getByLabelText(c.commands.model), { target: { value: 'gpt-x' } })
    fireEvent.click(screen.getByRole('button', { name: c.commands.save }))
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/api/panel/code/sessions/s1', { model: 'gpt-x' }),
    )
    await waitFor(() => expect(screen.queryByLabelText(c.commands.model)).toBeNull())
    fireEvent.keyDown(type('/rename'), { key: 'Enter' })
    fireEvent.change(screen.getByLabelText(c.commands.rename), { target: { value: 'New' } })
    fireEvent.click(screen.getByRole('button', { name: c.commands.save }))
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/api/panel/code/sessions/s1', { title: 'New' }),
    )
    await waitFor(() => expect(onRenamed).toHaveBeenCalledWith('New'))
  })

  it('asks before /end ends the session, and sends nothing when the owner cancels', async () => {
    vi.mocked(del).mockResolvedValue({})
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<CodeConversation session={session('idle')} events={[]} />)
    fireEvent.keyDown(type('/end'), { key: 'Enter' })
    expect(confirm).toHaveBeenCalledWith(c.confirmEnd)
    expect(del).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    fireEvent.keyDown(type('/end'), { key: 'Enter' })
    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/panel/code/sessions/s1'))
    confirm.mockRestore()
  })

  it('asks before the /end option ends the session', async () => {
    vi.mocked(del).mockResolvedValue({})
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<CodeConversation session={session('idle')} events={[]} />)
    type('/end')
    fireEvent.mouseDown(screen.getByRole('option'))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(del).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    type('/end')
    fireEvent.mouseDown(screen.getByRole('option'))
    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/panel/code/sessions/s1'))
    confirm.mockRestore()
  })

  it('disables the box of an ended session, whose /end is refused', () => {
    render(<CodeConversation session={session('ended')} events={[]} />)
    const box = screen.getByLabelText(c.message) as HTMLTextAreaElement
    expect(box.disabled).toBe(true)
    expect(box.placeholder).toBe(c.refused.ended)
    type('/end')
    expect(screen.getByRole('option').textContent).toContain(c.commands.reasons.ended)
  })

  it('sends text that starts with a slash and matches no command', async () => {
    vi.mocked(post).mockResolvedValue({})
    render(<CodeConversation session={session('idle')} events={[]} />)
    const box = type('/usr/bin is where')
    expect(screen.queryByRole('option')).toBeNull()
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/panel/code/sessions/s1/messages', {
        text: '/usr/bin is where',
      }),
    )
    type('/nope')
    expect(screen.queryByRole('option')).toBeNull()
  })
})

describe('the assist of a session', () => {
  const contexts = () => screen.getAllByTestId('assist').map((a) => a.getAttribute('data-context'))

  it('tells the assist of the message box the repository, the work branch and the changed paths', () => {
    render(
      <CodeConversation
        session={session('idle')}
        events={[]}
        files={['README.md', 'src/isEvenOrOdd.js']}
        changed={['src/isEvenOrOdd.js']}
      />,
    )
    expect(contexts()).toEqual([c.assistContext('acme/shop', 'code/s1', ['src/isEvenOrOdd.js'], 0)])
    expect(contexts()[0]).toContain('src/isEvenOrOdd.js')
    expect(contexts()[0]).toContain('code/s1')
    expect(contexts()[0]).not.toContain('README.md')
  })

  it('tells the assist of the plan revision box the same session', () => {
    render(
      <CodeConversation
        session={session('waiting_input')}
        events={[ev(1, 'user_message', 'plan it'), ev(2, 'plan', '## What exists\nold')]}
        changed={['src/a.ts']}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: c.plan.revise }))
    const want = c.assistContext('acme/shop', 'code/s1', ['src/a.ts'], 0)
    const [plan, message] = contexts()
    expect(message).toBe(want)
    expect(plan?.endsWith(want)).toBe(true)
  })

  it('gives the assist of the plan revision box the plan on screen, and says the owner revises it (#775)', () => {
    const clamp =
      '## Plan\n- add `src/clamp.js` with clamp(value, min, max)\n- add `src/clamp.test.js`'
    render(
      <CodeConversation
        session={session('waiting_input')}
        events={[ev(1, 'user_message', 'plan clamp'), ev(2, 'plan', clamp)]}
        changed={['src/minOf.js', 'src/minOf.test.js', 'docs/min.md', 'NOTES.md']}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: c.plan.revise }))
    const [plan, message] = contexts()
    expect(plan).toBe(
      `${c.plan.assistContext(clamp, false)}\n${c.assistContext('acme/shop', 'code/s1', ['src/minOf.js', 'src/minOf.test.js', 'docs/min.md', 'NOTES.md'], 0)}`,
    )
    expect(plan).toContain(clamp)
    expect(plan).toContain('The owner is revising the plan below')
    expect(plan).not.toContain('cut:')
    expect(message).not.toContain('clamp')
  })

  it('cuts a long plan at the limit and says it was cut', () => {
    const long = `${'a'.repeat(PLAN_CONTEXT_CHARS)}TAIL`
    render(
      <CodeConversation
        session={session('waiting_input')}
        events={[ev(1, 'user_message', 'plan it'), ev(2, 'plan', long)]}
        changed={[]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: c.plan.revise }))
    const [plan] = contexts()
    expect(plan).toContain(c.plan.assistContext('a'.repeat(PLAN_CONTEXT_CHARS), true))
    expect(plan).toContain('cut: only its beginning is shown')
    expect(plan).not.toContain('TAIL')
  })

  it('says the plan revision in Portuguese on a page in Portuguese', () => {
    window.localStorage.setItem('aifactory.language', 'pt-BR')
    try {
      render(
        <CopyProvider>
          <CodeConversation
            session={session('waiting_input')}
            events={[ev(1, 'user_message', 'planeje'), ev(2, 'plan', 'clamp')]}
            changed={[]}
          />
        </CopyProvider>,
      )
      fireEvent.click(screen.getByRole('button', { name: ptBR.code.conversation.plan.revise }))
    } finally {
      window.localStorage.clear()
    }
    expect(contexts()[0]).toContain(ptBR.code.conversation.plan.assistContext('clamp', false))
  })

  it('says the changed files could not be read, never listing the workspace in their place', () => {
    render(
      <CodeConversation session={session('idle')} events={[]} files={['README.md', 'src/a.ts']} />,
    )
    const [context] = contexts()
    expect(context).toBe(c.assistContext('acme/shop', 'code/s1', undefined, 0))
    expect(context).toContain('could not be read')
    expect(context).not.toContain('README.md')
  })

  it('says the session changed nothing yet, and counts the paths past the limit', () => {
    const many = Array.from({ length: CONTEXT_PATHS + 2 }, (_, i) => `f${i}.ts`)
    render(<CodeConversation session={session('idle')} events={[]} changed={many} />)
    expect(contexts()[0]).toContain(`f${CONTEXT_PATHS - 1}.ts and 2 more`)
    expect(contexts()[0]).not.toContain(`f${CONTEXT_PATHS}.ts`)
    cleanup()
    render(<CodeConversation session={session('idle')} events={[]} changed={[]} />)
    expect(contexts()[0]).toContain('no file yet')
  })

  it('says it in Portuguese on a page in Portuguese', () => {
    window.localStorage.setItem('aifactory.language', 'pt-BR')
    try {
      render(
        <CopyProvider>
          <CodeConversation session={session('idle')} events={[]} changed={['src/a.ts']} />
        </CopyProvider>,
      )
    } finally {
      window.localStorage.clear()
    }
    expect(contexts()[0]).toBe(
      ptBR.code.conversation.assistContext('acme/shop', 'code/s1', ['src/a.ts'], 0),
    )
  })
})

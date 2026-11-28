// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CopyProvider, LANGUAGE_KEY } from '../lib/copy'
import { en } from '../lib/copy/en'
import { ptBR } from '../lib/copy/pt-BR'

import { Assist } from './Assist'

type Agent = {
  thread: unknown[]
  status: 'idle' | 'streaming' | 'error'
  error: Error | undefined
  send: ReturnType<typeof vi.fn>
  reset: ReturnType<typeof vi.fn>
}

let agent: Agent
let used: { path: string; options: unknown }[]

vi.mock('@getloopscale/loopzero/client', () => ({
  useAgent: (path: string, options: unknown) => {
    used.push({ path, options })
    return agent
  },
}))

const proposed = (input: object) => [
  {
    id: 'a',
    role: 'assistant',
    parts: [{ type: 'dynamic-tool', toolName: 'propose', state: 'output-available', input }],
  },
]

/** What `GET /api/panel/health` answers; the component reads it only once the assistant failed. */
let assistProvider: unknown
let healthReads: number

beforeEach(() => {
  used = []
  agent = { thread: [], status: 'idle', error: undefined, send: vi.fn(), reset: vi.fn() }
  assistProvider = null
  healthReads = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      if (path !== '/api/panel/health') return new Response('{}', { status: 404 })
      healthReads += 1
      return new Response(JSON.stringify({ cost: {}, findings: [], assistProvider }))
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const creditRefusal = {
  provider: 'anthropic',
  reason: 'credit',
  since: '2026-11-28T10:00:00Z',
  lastAt: '2026-11-28T10:40:00Z',
}

const mount = (over: Partial<Parameters<typeof Assist>[0]> = {}) => {
  const onUse = vi.fn()
  render(<Assist kind="goal" text="a site for my clients" onUse={onUse} {...over} />)
  return onUse
}

describe('the assistant under a text box', () => {
  it('talks to the assistant that reads nothing, and sends the CSRF header the server wants', () => {
    mount()
    expect(used[0].path).toBe('/api/agents/assist')
    expect(used[0].options).toEqual({ headers: { 'x-loopzero-action': '1' } })
  })

  it('talks to the setup assistant for a repository setup', () => {
    mount({ kind: 'setup', text: '', repository: 'o/r' })
    expect(used[0].path).toBe('/api/agents/assist-setup')
  })

  it('asks with what the owner wrote, starting from a clean conversation', () => {
    mount({ repository: 'o/r', context: 'ctx' })
    fireEvent.click(screen.getByRole('button', { name: 'Help me say it' }))
    expect(agent.reset).toHaveBeenCalled()
    expect(agent.send).toHaveBeenCalledWith({
      message:
        'kind: goal\nlanguage: en\nrepository: o/r\ncontext: ctx\n\nThe owner wrote:\na site for my clients',
    })
  })

  it('waits for a few words before it helps, except when it can look at the project', () => {
    mount({ text: '  ' })
    expect(
      (screen.getByRole('button', { name: 'Help me say it' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(screen.getByText('Write a few words first.')).toBeDefined()
    cleanup()
    mount({ kind: 'setup', text: '', repository: 'o/r' })
    expect(
      (screen.getByRole('button', { name: 'Set this up for me' }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  it('has its own words on the button for each kind', () => {
    for (const [kind, label] of [
      ['job', 'Help me say it'],
      ['changes', 'Help me say it'],
      ['issue', 'Improve this'],
      ['setup', 'Set this up for me'],
    ] as const) {
      mount({ kind, text: 'enough words', repository: 'o/r' })
      expect(screen.getByRole('button', { name: label })).toBeDefined()
      cleanup()
    }
  })

  it('says it is working, and does not let the owner ask twice', () => {
    agent.status = 'streaming'
    mount()
    expect(screen.getByRole('status').textContent).toBe('Working on it…')
    expect(
      (screen.getByRole('button', { name: 'Help me say it' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('shows the suggestion with its notes, and hands it over only when the owner says so', () => {
    agent.thread = proposed({
      title: 'Booking site',
      text: 'A site to book.',
      notes: 'I assumed one person.',
      domains: ['pypi.org'],
    })
    const onUse = mount()
    const box = screen.getByRole('region', { name: 'Suggestion' })
    expect(box.textContent).toContain('Booking site')
    expect(box.textContent).toContain('A site to book.')
    expect(box.textContent).toContain('I assumed one person.')
    expect(box.textContent).toContain('Extra domains: pypi.org')
    expect(onUse).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Use this' }))

    expect(onUse).toHaveBeenCalledWith({
      title: 'Booking site',
      text: 'A site to book.',
      notes: 'I assumed one person.',
      domains: ['pypi.org'],
    })
    expect(agent.reset).toHaveBeenCalled()
  })

  it('drops the suggestion without using it', () => {
    agent.thread = proposed({ text: 'A site to book.', notes: '' })
    const onUse = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(agent.reset).toHaveBeenCalled()
    expect(onUse).not.toHaveBeenCalled()
  })

  it('asks for a change in the owner words, on the same kind of text', () => {
    agent.thread = proposed({ text: 'A site to book.', notes: '' })
    mount()
    const change = screen.getByRole('button', { name: 'Change it' }) as HTMLButtonElement
    expect(change.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Ask for a change'), {
      target: { value: '  shorter  ' },
    })
    fireEvent.click(change)
    expect(agent.send).toHaveBeenCalledWith({
      message:
        'kind: goal\nlanguage: en\n\nThe owner wrote:\na site for my clients\n\nThe owner then asked for a change to your suggestion: shorter',
    })
    expect((screen.getByLabelText('Ask for a change') as HTMLInputElement).value).toBe('')
  })

  it('hides the suggestion while a new one is being written', () => {
    agent.thread = proposed({ text: 'old', notes: '' })
    agent.status = 'streaming'
    mount()
    expect(screen.queryByRole('region', { name: 'Suggestion' })).toBeNull()
  })

  it('says what went wrong, in words the owner can act on', async () => {
    agent.status = 'error'
    agent.error = new Error('invalid x-api-key')
    mount()
    expect((await screen.findByRole('alert')).textContent).toMatch(/ANTHROPIC_API_KEY/)
  })

  it('names credit as the cause when the provider refused for it, never "An error occurred."', async () => {
    assistProvider = creditRefusal
    agent.status = 'error'
    agent.error = new Error('An error occurred.')
    mount({ kind: 'changes', text: 'fix the header' })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(en.assistProblems.creditRefused('Anthropic'))
    expect(alert.textContent).not.toMatch(/An error occurred/)
  })

  it('reads nothing of the provider while the assistant answers', () => {
    mount()
    expect(healthReads).toBe(0)
  })

  it('says the error as it came when the health report cannot be read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 500 })),
    )
    agent.status = 'error'
    agent.error = new Error('socket hang up')
    mount()
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        en.assistProblems.couldNot('socket hang up'),
      ),
    )
  })
})

describe('the assistant in the language of the panel', () => {
  afterEach(() => window.localStorage.clear())

  it.each([
    ['en', en],
    ['pt-BR', ptBR],
  ] as const)('writes its button and its hint in %s', (language, copy) => {
    window.localStorage.setItem(LANGUAGE_KEY, language)
    render(
      <CopyProvider>
        <Assist kind="job" text="" onUse={vi.fn()} />
      </CopyProvider>,
    )
    expect(screen.getByRole('button', { name: copy.assist.label.job })).toBeTruthy()
    expect(screen.getByText(copy.assist.needsWords)).toBeTruthy()
  })

  it.each([
    ['en', en],
    ['pt-BR', ptBR],
  ] as const)('names the refusal for credit in %s', async (language, copy) => {
    window.localStorage.setItem(LANGUAGE_KEY, language)
    assistProvider = creditRefusal
    agent.status = 'error'
    agent.error = new Error('An error occurred.')
    render(
      <CopyProvider>
        <Assist kind="changes" text="arrumar o cabeçalho" onUse={vi.fn()} />
      </CopyProvider>,
    )
    expect((await screen.findByRole('alert')).textContent).toBe(
      copy.assistProblems.creditRefused('Anthropic'),
    )
  })

  it.each(['en', 'pt-BR'] as const)(
    'tells the assistant the page is in %s, on the first request and on a change',
    (language) => {
      window.localStorage.setItem(LANGUAGE_KEY, language)
      agent.thread = proposed({ text: 'Adiciona maxOf.', notes: '' })
      render(
        <CopyProvider>
          <Assist
            kind="pr_title"
            text="função do maior número"
            context="src/maxOf.js"
            onUse={vi.fn()}
          />
        </CopyProvider>,
      )
      const copy = language === 'en' ? en : ptBR
      fireEvent.click(screen.getByRole('button', { name: copy.assist.label.pr_title }))
      fireEvent.change(screen.getByLabelText(copy.assist.askChange), {
        target: { value: 'mais curto' },
      })
      fireEvent.click(screen.getByRole('button', { name: copy.assist.change }))
      expect(agent.send).toHaveBeenCalledTimes(2)
      for (const [{ message }] of agent.send.mock.calls) {
        expect(message).toMatch(new RegExp(`^kind: pr_title\\nlanguage: ${language}\\n`))
      }
    },
  )

  it('tells the assistant of a plan revision that the page is in Portuguese (#775)', () => {
    window.localStorage.setItem(LANGUAGE_KEY, 'pt-BR')
    render(
      <CopyProvider>
        <Assist
          kind="changes"
          text="chama de limitar e não mexe no readme"
          context="O plano: clamp(valor, min, max)"
          onUse={vi.fn()}
        />
      </CopyProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: ptBR.assist.label.changes }))
    const [[{ message }]] = agent.send.mock.calls
    expect(message).toMatch(/^kind: changes\nlanguage: pt-BR\n/)
    expect(message).toContain('context: O plano: clamp(valor, min, max)')
  })

  it('writes a suggestion and its buttons in Portuguese', () => {
    window.localStorage.setItem(LANGUAGE_KEY, 'pt-BR')
    agent.thread = proposed({ text: 'Uma página', domains: ['a.com'] })
    render(
      <CopyProvider>
        <Assist kind="job" text="uma página" onUse={vi.fn()} />
      </CopyProvider>,
    )
    expect(screen.getByRole('region', { name: ptBR.assist.suggestion })).toBeTruthy()
    expect(screen.getByRole('button', { name: ptBR.assist.use })).toBeTruthy()
    expect(screen.getByRole('button', { name: ptBR.assist.dismiss })).toBeTruthy()
    expect(screen.getByRole('button', { name: ptBR.assist.change })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: ptBR.assist.askChange })).toBeTruthy()
    expect(screen.getByText(ptBR.assist.extraDomains('a.com'))).toBeTruthy()
  })
})

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentSettings } from '../../../shared/panel'

import { en } from '../../lib/copy/en'

import { EngineChooser } from './EngineChooser'

// Without a provider the panel speaks English, and the expected text comes from its dictionary.
const e = en.engine

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const settings = (over: Partial<AgentSettings> = {}): AgentSettings => ({
  options: [
    { id: 'claude-code', ready: true },
    { id: 'codex', ready: true },
  ],
  chosen: { builder: null, planner: null, reviewer: null },
  effective: { builder: 'codex', planner: 'codex', reviewer: 'codex' },
  repositoriesWithOwn: [],
  chosenModel: { builder: null, planner: null, reviewer: null },
  chosenEffort: { builder: null, planner: null, reviewer: null },
  engines: {
    'claude-code': {
      models: [
        {
          id: 'sonnet',
          label: 'Sonnet',
          note: 'Apelido: o mais recente.',
          efforts: ['low', 'high'],
        },
        {
          id: 'opus',
          label: 'Opus',
          note: 'Apelido: o mais recente.',
          efforts: ['low', 'medium', 'high'],
        },
      ],
      efforts: ['low', 'medium', 'high'],
    },
    codex: {
      models: [
        {
          id: 'gpt-6.1-sol',
          label: 'GPT-6.1-Sol',
          note: 'O cavalo de batalha.',
          efforts: ['low', 'medium', 'high', 'ultra'],
        },
        {
          id: 'gpt-6-luna',
          label: 'GPT-6-Luna',
          note: 'Rápido e barato.',
          efforts: ['low', 'medium'],
        },
      ],
      efforts: ['low', 'medium', 'high', 'ultra'],
    },
  },
  ...over,
})

function mount(
  role: 'builder' | 'planner' | 'reviewer',
  s = settings(),
  answer = new Response('{}'),
) {
  const fetchMock = vi.fn(async () => answer)
  vi.stubGlobal('fetch', fetchMock)
  const onSaved = vi.fn()
  render(
    <MemoryRouter>
      <EngineChooser role={role} settings={s} onSaved={onSaved} />
    </MemoryRouter>,
  )
  return { fetchMock, onSaved }
}

const choose = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } })

const optionsOf = (label: string) =>
  within(screen.getByLabelText(label))
    .getAllByRole('option')
    .map((o) => o.textContent)

describe('choosing the coding agent of a role', () => {
  it('shows the agent in use for the builder, and has nothing to save until something changes', () => {
    mount('builder')
    expect((screen.getByLabelText(e.roleLabel.builder) as HTMLSelectElement).value).toBe('codex')
    expect(optionsOf(e.roleLabel.builder)).toEqual(['claude-code', 'codex'])
    expect((screen.getByRole('button', { name: e.save }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('saves a new builder, and says it applies to the next runs without a restart', async () => {
    const { fetchMock, onSaved } = mount('builder')
    choose(e.roleLabel.builder, 'claude-code')
    fireEvent.click(screen.getByRole('button', { name: e.save }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(e.saved))
    const [url, init] = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0]
    expect(url).toBe('/api/panel/agents/settings')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual({
      builder: 'claude-code',
      models: { builder: null },
      efforts: { builder: null },
    })
    expect(onSaved).toHaveBeenCalled()
  })

  it('lets the planner and the reviewer follow the builder, which is saved as going back to the default', async () => {
    const { fetchMock } = mount(
      'planner',
      settings({ chosen: { builder: null, planner: 'claude-code', reviewer: null } }),
    )
    const box = screen.getByLabelText(e.roleLabel.planner) as HTMLSelectElement
    expect(box.value).toBe('claude-code')
    expect(optionsOf(e.roleLabel.planner)).toEqual([
      e.sameAsBuilder('codex'),
      'claude-code',
      'codex',
    ])
    choose(e.roleLabel.planner, '')
    fireEvent.click(screen.getByRole('button', { name: e.save }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [, init] = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0]
    expect(JSON.parse(String(init.body)).planner).toBeNull()
  })

  it('shows "the same as the builder" for a role that was not given another', () => {
    mount('reviewer')
    expect((screen.getByLabelText(e.roleLabel.reviewer) as HTMLSelectElement).value).toBe('')
  })

  it('cannot pick an agent that cannot start, and says what is missing', () => {
    mount(
      'builder',
      settings({
        options: [
          { id: 'claude-code', ready: false, problem: 'CLAUDE_CODE_OAUTH_TOKEN is not set' },
          { id: 'codex', ready: true },
        ],
      }),
    )
    const claude = screen.getByRole('option', {
      name: `claude-code${e.unavailable}`,
    }) as HTMLOptionElement
    expect(claude.disabled).toBe(true)
    expect(
      screen.getByText(new RegExp(`${e.cannotChoose.trim()} CLAUDE_CODE_OAUTH_TOKEN is not set`)),
    ).toBeDefined()
  })

  it('names the repositories that have an agent of their own, which wins over this choice', () => {
    mount(
      'builder',
      settings({
        repositoriesWithOwn: [
          { repository: 'o/own', builder: 'claude-code', reviewer: null },
          { repository: 'o/rev', builder: null, reviewer: 'codex' },
        ],
      }),
    )
    expect(screen.getByText(/o\/own\./)).toBeDefined()
    expect(screen.queryByText(/o\/rev/)).toBeNull()
    expect(screen.getByRole('link', { name: e.changeInRepositories }).getAttribute('href')).toBe(
      '/repositories',
    )
    cleanup()
    mount(
      'reviewer',
      settings({
        repositoriesWithOwn: [{ repository: 'o/rev', builder: null, reviewer: 'codex' }],
      }),
    )
    expect(screen.getByText(/o\/rev\./)).toBeDefined()
  })

  it('shows the refusal of the server, and keeps the choice for another try', async () => {
    const { onSaved } = mount(
      'builder',
      settings(),
      new Response(JSON.stringify({ error: 'refused', message: 'codex cannot start: x' }), {
        status: 409,
      }),
    )
    choose(e.roleLabel.builder, 'claude-code')
    fireEvent.click(screen.getByRole('button', { name: e.save }))
    expect((await screen.findByRole('alert')).textContent).toContain('codex cannot start: x')
    expect(onSaved).not.toHaveBeenCalled()
    expect((screen.getByLabelText(e.roleLabel.builder) as HTMLSelectElement).value).toBe(
      'claude-code',
    )
  })
})

describe('choosing the model and the effort', () => {
  it('offers the models of the agent in use, with its own default first', () => {
    mount('builder')
    expect(optionsOf(e.modelOf(e.roleName.builder))).toEqual([
      e.agentDefault,
      'GPT-6.1-Sol',
      'GPT-6-Luna',
    ])
    expect(optionsOf(e.effortOf(e.roleName.builder))).toEqual([
      e.default,
      'low',
      'medium',
      'high',
      'ultra',
    ])
  })

  it('shows what was chosen, and what the model is for', () => {
    mount(
      'builder',
      settings({
        chosenModel: { builder: 'gpt-6-luna', planner: null, reviewer: null },
        chosenEffort: { builder: 'medium', planner: null, reviewer: null },
      }),
    )
    expect((screen.getByLabelText(e.modelOf(e.roleName.builder)) as HTMLSelectElement).value).toBe(
      'gpt-6-luna',
    )
    expect((screen.getByLabelText(e.effortOf(e.roleName.builder)) as HTMLSelectElement).value).toBe(
      'medium',
    )
    expect(screen.getByText('Rápido e barato.')).toBeDefined()
  })

  it('narrows the effort to what the chosen model takes, and drops one it does not take', () => {
    mount('builder')
    choose(e.effortOf(e.roleName.builder), 'ultra')
    choose(e.modelOf(e.roleName.builder), 'gpt-6-luna')
    expect(optionsOf(e.effortOf(e.roleName.builder))).toEqual([e.default, 'low', 'medium'])
    expect((screen.getByLabelText(e.effortOf(e.roleName.builder)) as HTMLSelectElement).value).toBe(
      '',
    )
    choose(e.effortOf(e.roleName.builder), 'medium')
    choose(e.modelOf(e.roleName.builder), 'gpt-6.1-sol')
    expect((screen.getByLabelText(e.effortOf(e.roleName.builder)) as HTMLSelectElement).value).toBe(
      'medium',
    )
  })

  it("swaps the lists for the other agent's, and forgets a model that belongs to the first", () => {
    mount(
      'builder',
      settings({ chosenModel: { builder: 'gpt-6.1-sol', planner: null, reviewer: null } }),
    )
    choose(e.roleLabel.builder, 'claude-code')
    expect(optionsOf(e.modelOf(e.roleName.builder))).toEqual([e.agentDefault, 'Sonnet', 'Opus'])
    expect((screen.getByLabelText(e.modelOf(e.roleName.builder)) as HTMLSelectElement).value).toBe(
      '',
    )
    expect(optionsOf(e.effortOf(e.roleName.builder))).toEqual([e.default, 'low', 'medium', 'high'])
  })

  it('follows the agent of the builder for a planner that has none of its own', () => {
    mount('planner')
    expect(optionsOf(e.modelOf(e.roleName.planner))).toEqual([
      e.agentDefault,
      'GPT-6.1-Sol',
      'GPT-6-Luna',
    ])
  })

  it('saves a model and an effort for the role, and sends the agent only when it changed', async () => {
    const { fetchMock } = mount('builder')
    choose(e.modelOf(e.roleName.builder), 'gpt-6.1-sol')
    choose(e.effortOf(e.roleName.builder), 'high')
    fireEvent.click(screen.getByRole('button', { name: e.save }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [, init] = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0]
    expect(JSON.parse(String(init.body))).toEqual({
      models: { builder: 'gpt-6.1-sol' },
      efforts: { builder: 'high' },
    })
  })

  it('sends the agent with its model when both changed, and null where it went back to the default', async () => {
    const { fetchMock } = mount(
      'builder',
      settings({ chosenModel: { builder: 'gpt-6.1-sol', planner: null, reviewer: null } }),
    )
    choose(e.roleLabel.builder, 'claude-code')
    choose(e.modelOf(e.roleName.builder), 'opus')
    fireEvent.click(screen.getByRole('button', { name: e.save }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [, init] = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0]
    expect(JSON.parse(String(init.body))).toEqual({
      builder: 'claude-code',
      models: { builder: 'opus' },
      efforts: { builder: null },
    })
  })

  it('has something to save when only the model changed, and nothing once it is back', () => {
    mount('builder')
    const save = () => (screen.getByRole('button', { name: e.save }) as HTMLButtonElement).disabled
    choose(e.modelOf(e.roleName.builder), 'gpt-6-luna')
    expect(save()).toBe(false)
    choose(e.modelOf(e.roleName.builder), '')
    expect(save()).toBe(true)
  })

  it('says an agent has no list of models here, and offers only its default', () => {
    mount(
      'builder',
      settings({
        engines: { 'claude-code': { models: [], efforts: [] }, codex: { models: [], efforts: [] } },
      }),
    )
    expect(optionsOf(e.modelOf(e.roleName.builder))).toEqual([e.agentDefault])
    expect(screen.getByText(e.noModelList('codex'))).toBeDefined()
  })

  it('copes with an agent the page has no list for', () => {
    mount('builder', settings({ engines: {} }))
    expect(optionsOf(e.modelOf(e.roleName.builder))).toEqual([e.agentDefault])
  })
})

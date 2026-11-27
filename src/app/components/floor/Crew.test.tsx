// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { en } from '../../lib/copy/en'

import { Crew } from './Crew'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const roles = ['planner', 'builder', 'reviewer', 'security', 'merger']
const everyRole = <T,>(value: T) => Object.fromEntries(roles.map((r) => [r, value]))

function show(models: unknown, chosenModel: Record<string, string | null> = everyRole(null)) {
  const view = {
    settings: { effective: { ...everyRole('codex'), builder: 'claude-code' }, chosenModel },
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Response(JSON.stringify(url.endsWith('/models') ? { models } : view)),
    ),
  )
  render(
    <MemoryRouter>
      <Crew />
    </MemoryRouter>,
  )
}

describe('the crew and the model of each role', () => {
  it('names the model of the agent the role uses now, never one of another agent', async () => {
    show({
      builder: { 'claude-code': 'claude-sonnet-5-5', codex: 'gpt-6.1-sol' },
      reviewer: { 'claude-code': 'claude-sonnet-5-5' },
    })
    await screen.findByText('claude-sonnet-5-5')
    expect(screen.queryByText('gpt-6.1-sol')).toBeNull()
    // Four roles use codex, which reported nothing for the reviewer, planner, security or merger.
    expect(screen.getAllByText(en.floor.modelUnknown)).toHaveLength(4)
  })

  it('shows the model the owner chose over the reported one', async () => {
    show(
      { builder: { 'claude-code': 'claude-sonnet-5-5' } },
      { ...everyRole(null), builder: 'opus' },
    )
    await screen.findByText('opus')
    expect(screen.queryByText('claude-sonnet-5-5')).toBeNull()
  })
})

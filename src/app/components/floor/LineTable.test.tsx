// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import type { TaskCard } from '../../../shared/panel'
import { card } from '../../../test/floor-fixtures'
import { en } from '../../lib/copy/en'
import type { FloorState } from '../../lib/floor'

import { LineRow } from './LineTable'

afterEach(cleanup)

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

function row(
  task: TaskCard,
  {
    state = 'moving',
    now = 'building',
    detail,
    at = '/floor',
  }: { state?: FloorState; now?: string; detail?: string; at?: string } = {},
) {
  render(
    <MemoryRouter initialEntries={[at]}>
      <ul>
        <LineRow task={task} state={state} now={now} detail={detail} />
      </ul>
    </MemoryRouter>,
  )
  return screen.getByRole('link')
}

describe('a row of the line', () => {
  it('links to its task beside the line', () => {
    const link = row(card({ id: 7 }))

    expect(link.getAttribute('href')).toBe('/floor?task=7')
    expect(link.getAttribute('aria-current')).toBeNull()
  })

  it('is marked as the current one while its task is open', () => {
    const link = row(card({ id: 7 }), { at: '/floor?task=7' })

    expect(link.getAttribute('aria-current')).toBe('true')
  })

  it('is not marked while another task is open', () => {
    const link = row(card({ id: 7 }), { at: '/floor?task=8' })

    expect(link.getAttribute('aria-current')).toBeNull()
  })

  it('says the title, the repository, the issue and when it was last touched', () => {
    const link = row(card({ title: 'Add truncate', issueNumber: 7, updatedAt: minutesAgo(5) }))

    expect(screen.getByText('Add truncate')).toBeDefined()
    expect(link.querySelector('[data-item-id]')?.textContent).toBe('#7')
    expect(link.textContent).toContain('#7Add truncate')
    expect(link.textContent).toContain('app · 5m ago')
  })

  it('shows the model of the agent at work and the step it is in', () => {
    const task = card({
      stage: 'build',
      working: { step: 'building', agent: 'claude-code', model: 'opus-9', attempt: 1 },
    })

    const link = row(task)

    expect(link.textContent).toContain('opus-9 · app ·')
    expect(screen.getByRole('img', { name: 'Claude Code' })).toBeDefined()
    expect(screen.getByRole('img', { name: 'Build, building' })).toBeDefined()
  })

  it('shows the model of the agent that worked last on a task nobody works on', () => {
    const link = row(card({ stage: 'review', lastAgent: { agent: 'codex', model: 'gpt-9' } }))

    expect(link.textContent).toContain('gpt-9 · app ·')
    expect(screen.getByRole('img', { name: 'Codex' })).toBeDefined()
    expect(screen.getByRole('img', { name: 'Review, moving' })).toBeDefined()
  })

  it('shows no model for an agent that reported none', () => {
    const link = row(card({ lastAgent: { agent: 'codex', model: null } }))

    expect(link.textContent).not.toContain(' · app')
    expect(link.textContent).toContain('app ·')
  })

  it('shows neither an agent nor a model while the factory runs the checks', () => {
    const task = card({
      stage: 'verify',
      working: { step: 'checks', checks: ['test'] },
      lastAgent: { agent: 'codex', model: 'gpt-9' },
    })

    const link = row(task)

    expect(link.textContent).not.toContain('gpt-9')
    expect(screen.queryByRole('img', { name: 'Codex' })).toBeNull()
    expect(screen.getByRole('img', { name: 'Checks, checks' })).toBeDefined()
  })

  it('shows no agent for a task none touched', () => {
    row(card({ stage: 'intake' }), { state: 'queued' })

    expect(screen.getAllByRole('img')).toHaveLength(1)
    expect(screen.getByRole('img', { name: 'Queue, queued' })).toBeDefined()
  })

  it('says a task that left the line is off it', () => {
    row(card({ stage: 'failed' }), { state: 'factory' })

    expect(screen.getByText(en.floor.offLine)).toBeDefined()
  })

  it('counts the attempts past the first', () => {
    const link = row(card({ attempts: 3 }))

    expect(link.textContent).toContain('3 attempts')
  })

  it('does not count a first attempt', () => {
    const link = row(card({ attempts: 1 }))

    expect(link.textContent).not.toContain('attempts')
  })

  it('says what happens now, with the second line under it', () => {
    row(card(), { now: 'Answer a question', detail: 'Which database?' })

    expect(screen.getByText('Answer a question')).toBeDefined()
    expect(screen.getByText('Which database?')).toBeDefined()
  })

  it('warns that the default branch went red after the release', () => {
    row(card({ stage: 'released', mainRed: true }), { state: 'delivered' })

    expect(screen.getByText(en.floor.mainRed)).toBeDefined()
  })

  it('does not warn about a default branch that is fine', () => {
    row(card({ stage: 'released' }), { state: 'delivered' })

    expect(screen.queryByText(en.floor.mainRed)).toBeNull()
  })

  it('shows what the task cost', () => {
    row(card({ costUsd: 0.31 }))

    expect(screen.getByText('$0.31')).toBeDefined()
  })

  it('shows no cost for a task that spent nothing', () => {
    const link = row(card({ costUsd: 0 }))

    expect(link.textContent).not.toContain('$')
  })
})

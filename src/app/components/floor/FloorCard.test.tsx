// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { ReturnReason } from '../../../shared/panel'
import { card } from '../../../test/floor-fixtures'
import { en } from '../../lib/copy/en'

import { AgentLine, waitLine } from './FloorCard'

afterEach(cleanup)

const since = '2026-11-04T10:00:00Z'

describe('waitLine', () => {
  it('names the branch and the one check a task waits for', () => {
    const task = card({ waitingOnBase: { branch: 'workspace', checks: ['test'], since } })

    expect(waitLine(task, en)).toBe('Waits for workspace: 1 required check fails there too')
  })

  it('counts the checks when the base fails more than one', () => {
    const task = card({ waitingOnBase: { branch: 'workspace', checks: ['test', 'lint'], since } })

    expect(waitLine(task, en)).toBe('Waits for workspace: 2 required checks fail there too')
  })

  it('says why a failure repeats by itself and when', () => {
    const task = card({
      stage: 'failed',
      retryable: 'quota',
      retryAt: new Date(Date.now() + 2 * 3600_000 + 60_000).toISOString(),
    })

    expect(waitLine(task, en)).toBe(`${en.floor.retry.quota} · ${en.time.runsInHours(2)}`)
  })

  it('says nothing for a failure that repeats at a time nobody set yet', () => {
    const task = card({ stage: 'failed', retryable: 'environment' })

    expect(waitLine(task, en)).toBe('')
  })

  it('says why work was sent back', () => {
    const task = card({ returned: { reason: 'review', at: since, note: null } })

    expect(waitLine(task, en)).toBe(en.floor.returned.review)
  })

  it('says only that work was sent back for a reason it has no words for', () => {
    const task = card({
      returned: { reason: 'something_new' as ReturnReason, at: since, note: null },
    })

    expect(waitLine(task, en)).toBe(en.floor.returned.other)
  })

  it('says the place of a queued task', () => {
    const task = card({
      stage: 'intake',
      queue: { position: 3, reasons: null, readiness: null },
    })

    expect(waitLine(task, en)).toBe('Place 3 in the queue')
  })

  it('says nothing for a queued task whose run has no place', () => {
    const task = card({
      stage: 'intake',
      queue: { position: null, reasons: null, readiness: null },
    })

    expect(waitLine(task, en)).toBe('')
  })

  it('says nothing for a task nothing holds', () => {
    expect(waitLine(card(), en)).toBe('')
  })
})

describe('AgentLine', () => {
  it('names the checks the factory runs', () => {
    render(<AgentLine task={card({ working: { step: 'checks', checks: ['lint', 'test'] } })} />)

    expect(screen.getByText(en.board.steps.checks)).toBeDefined()
    expect(screen.getByText('lint, test')).toBeDefined()
  })

  it('shows nothing for a task no agent touched', () => {
    const { container } = render(<AgentLine task={card()} />)

    expect(container.textContent).toBe('')
  })

  it('shows the agent that worked last with its model, and no step', () => {
    render(<AgentLine task={card({ lastAgent: { agent: 'claude-code', model: 'opus-9' } })} />)

    expect(screen.getByRole('img', { name: 'Claude Code' })).toBeDefined()
    expect(screen.getByText('opus-9')).toBeDefined()
    expect(screen.queryByText(en.board.steps.building)).toBeNull()
  })

  it('says the default model for an agent that reported none', () => {
    render(<AgentLine task={card({ lastAgent: { agent: 'codex', model: null } })} />)

    expect(screen.getByText(en.floor.defaultModel)).toBeDefined()
  })

  it('shows the agent at work with its model and the step it is in', () => {
    const task = card({
      working: { step: 'reviewing', agent: 'codex', model: 'gpt-9', attempt: 2 },
      lastAgent: { agent: 'claude-code', model: 'opus-9' },
    })

    render(<AgentLine task={task} />)

    expect(screen.getByRole('img', { name: 'Codex' })).toBeDefined()
    expect(screen.getByText('gpt-9')).toBeDefined()
    expect(screen.getByText('reviewing · round 2')).toBeDefined()
  })
})

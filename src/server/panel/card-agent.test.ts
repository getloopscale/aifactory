import { describe, expect, it } from 'vitest'

import { cardAgent, type StepEvent } from './card-agent'

const event = (id: number, stage: string, detail: unknown): StepEvent => ({ id, stage, detail })

describe('cardAgent', () => {
  it('names the agent and its model while it plans', () => {
    const events = [event(4, 'plan', { harness: 'codex', model: 'gpt-6.1-terra' })]
    expect(cardAgent('plan', events)).toEqual({
      working: { step: 'planning', agent: 'codex', model: 'gpt-6.1-terra', attempt: 1 },
      lastAgent: { agent: 'codex', model: 'gpt-6.1-terra' },
    })
  })

  it('leaves the model out when the stage recorded none', () => {
    const events = [event(4, 'build', { harness: 'claude-code', attempt: 1 })]
    expect(cardAgent('build', events).working).toEqual({
      step: 'building',
      agent: 'claude-code',
      model: null,
      attempt: 1,
    })
  })

  it('says a rework fixes findings, with its attempt', () => {
    const events = [
      event(4, 'plan', { harness: 'claude-code' }),
      event(9, 'build', { harness: 'claude-code', model: 'opus', attempt: 2, rework: true }),
      event(7, 'verify', { checks: ['tests'], attempt: 1 }),
    ]
    expect(cardAgent('build', events).working).toEqual({
      step: 'fixing',
      agent: 'claude-code',
      model: 'opus',
      attempt: 2,
    })
  })

  it('takes the reviewer and the round from a review', () => {
    const events = [
      event(5, 'build', { harness: 'claude-code', model: 'opus' }),
      event(8, 'review', { reviewer: 'codex', model: 'gpt-6.1-terra', attempt: 2 }),
    ]
    expect(cardAgent('review', events)).toEqual({
      working: { step: 'reviewing', agent: 'codex', model: 'gpt-6.1-terra', attempt: 2 },
      lastAgent: { agent: 'codex', model: 'gpt-6.1-terra' },
    })
  })

  it('shows the checks, and no agent, while the factory verifies', () => {
    const events = [
      event(5, 'build', { harness: 'claude-code', model: 'opus' }),
      event(6, 'verify', { checks: ['tests', 'lint', 3], attempt: 1 }),
    ]
    expect(cardAgent('verify', events)).toEqual({
      working: { step: 'checks', checks: ['tests', 'lint'] },
      lastAgent: { agent: 'claude-code', model: 'opus' },
    })
  })

  it('shows nothing at work on a task that is not in a step of its own, but keeps who worked last', () => {
    const events = [
      event(5, 'build', { harness: 'claude-code', model: 'opus' }),
      event(8, 'review', { reviewer: 'codex', attempt: 1 }),
    ]
    for (const stage of ['done', 'failed', 'push', 'waiting'] as const) {
      expect(cardAgent(stage, events)).toEqual({
        working: null,
        lastAgent: { agent: 'codex', model: null },
      })
    }
  })

  it('keeps an agent of a family it does not know as it is', () => {
    const events = [event(3, 'plan', { harness: 'gemini-cli', model: 'gemini-4' })]
    expect(cardAgent('plan', events).working).toMatchObject({ agent: 'gemini-cli' })
  })

  it('says nothing for a task no step has reached, or a stage whose detail names no agent', () => {
    expect(cardAgent('intake', [])).toEqual({ working: null, lastAgent: null })
    expect(cardAgent('build', [event(2, 'build', null)])).toEqual({
      working: null,
      lastAgent: null,
    })
  })

  it('does not take the step of an earlier stage for the one the task is in', () => {
    const events = [event(5, 'build', { harness: 'codex' })]
    expect(cardAgent('review', events).working).toBeNull()
  })
})

describe('the security review on a card', () => {
  it('shows the security agent and its own step while it reads an approved commit', () => {
    const events = [
      event(8, 'review', { reviewer: 'codex', model: 'gpt-6.1-terra', attempt: 1 }),
      event(9, 'review', { step: 'security', harness: 'claude-code', model: 'opus', attempt: 1 }),
    ]
    expect(cardAgent('review', events).working).toEqual({
      step: 'securing',
      agent: 'claude-code',
      model: 'opus',
      attempt: 1,
    })
  })
})

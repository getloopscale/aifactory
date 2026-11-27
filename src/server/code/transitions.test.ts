import { describe, expect, it } from 'vitest'

import { CODE_STATES } from '../../shared/code'

import { CODE_EVENTS, CODE_TRANSITIONS, transition } from './transitions'

describe('code session transitions', () => {
  it('has a row for every pair of state and event', () => {
    for (const state of CODE_STATES) {
      for (const event of CODE_EVENTS) {
        const outcome = CODE_TRANSITIONS[state]?.[event]
        expect(outcome, `${state} + ${event}`).toBeDefined()
        if (outcome!.action !== 'move') expect(outcome!.reason.length).toBeGreaterThan(0)
      }
    }
  })

  it('has no row for a state or event that does not exist', () => {
    expect(Object.keys(CODE_TRANSITIONS).sort()).toEqual([...CODE_STATES].sort())
    for (const state of CODE_STATES) {
      expect(Object.keys(CODE_TRANSITIONS[state]).sort()).toEqual([...CODE_EVENTS].sort())
    }
  })

  it('moves a session through a turn', () => {
    const steps = [
      ['idle', 'message', 'queued'],
      ['queued', 'turn_started', 'starting'],
      ['starting', 'turn_started', 'running'],
      ['running', 'turn_ended', 'idle'],
    ] as const
    for (const [from, event, next] of steps) {
      expect(transition(from, event)).toEqual({ action: 'move', state: next })
    }
  })

  it('gives a claimed turn back to the queue, and only a claimed one', () => {
    for (const from of ['starting', 'running'] as const) {
      expect(transition(from, 'turn_released')).toEqual({ action: 'move', state: 'queued' })
    }
    for (const from of ['idle', 'stopped', 'ended', 'failed', 'waiting_input'] as const) {
      expect(transition(from, 'turn_released').action).not.toBe('move')
    }
  })

  it('waits for the answer to a plan, then queues the next turn', () => {
    expect(transition('running', 'plan_proposed')).toEqual({
      action: 'move',
      state: 'waiting_input',
    })
    expect(transition('waiting_input', 'plan_answered')).toEqual({
      action: 'move',
      state: 'queued',
    })
    expect(transition('waiting_input', 'message').action).toBe('refused')
  })

  it('lets a stopped or failed session start again, never an ended one', () => {
    expect(transition('stopped', 'message')).toEqual({ action: 'move', state: 'queued' })
    expect(transition('failed', 'message')).toEqual({ action: 'move', state: 'queued' })
    expect(transition('ended', 'message').action).toBe('refused')
    for (const event of CODE_EVENTS) expect(transition('ended', event).action).not.toBe('move')
  })

  it('refuses a message while the agent works and ignores a late event', () => {
    expect(transition('running', 'message').action).toBe('refused')
    expect(transition('stopped', 'turn_ended').action).toBe('ignored')
    expect(transition('stopped', 'stop').action).toBe('ignored')
  })

  it('stops an idle session on timeout and fails an active turn', () => {
    expect(transition('idle', 'idle_timeout')).toEqual({ action: 'move', state: 'stopped' })
    expect(transition('running', 'idle_timeout').action).toBe('ignored')
    expect(transition('running', 'turn_failed')).toEqual({ action: 'move', state: 'failed' })
  })
})

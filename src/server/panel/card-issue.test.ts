import { describe, expect, it } from 'vitest'

import { countChecks, issueFacts } from './card-issue'

describe('issueFacts', () => {
  it('reads the labels without the one that asks for the work', () => {
    const payload = {
      issue: { labels: [{ name: 'factory' }, { name: 'bug' }, { name: 'priority:1' }] },
    }
    expect(issueFacts('github', payload).labels).toEqual(['bug', 'priority:1'])
  })

  it('says the factory opened an issue a GitHub App opened', () => {
    expect(issueFacts('github', { issue: { user: { type: 'Bot' } } }).origin).toBe('factory')
    expect(issueFacts('github', { issue: { user: { type: 'User' } } }).origin).toBe('person')
  })

  it('says Linear for an item that came from Linear, whoever opened it', () => {
    expect(issueFacts('linear', { issue: { user: { type: 'Bot' } } }).origin).toBe('linear')
  })

  it('reads a delivery with no issue as a person and no labels', () => {
    expect(issueFacts('github', {})).toEqual({ labels: [], origin: 'person' })
    expect(issueFacts('github', { issue: { labels: 'bug' } }).labels).toEqual([])
  })
})

describe('countChecks', () => {
  it('counts the last run of each check, given newest first', () => {
    const runs = [
      { name: 'test', passed: true },
      { name: 'lint', passed: false },
      { name: 'test', passed: false },
    ]
    expect(countChecks(runs)).toEqual({ passed: 1, total: 2 })
  })

  it('has nothing to say when no check ran', () => {
    expect(countChecks([])).toBeNull()
  })
})

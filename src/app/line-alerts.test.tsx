// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { StoppedLine } from '../shared/panel'

import { LineAlerts } from './components/LineAlerts'

afterEach(cleanup)

const line = (over: Partial<StoppedLine> = {}): StoppedLine => ({
  repository: 'usetheokit/theokit',
  cause: 'promotion_red',
  surface: 'workspace -> develop',
  issueNumber: 2400,
  issueUrl: 'https://github.com/usetheokit/theokit/issues/2400',
  status: 'open',
  attempts: 1,
  since: '2026-11-19T10:00:00Z',
  ...over,
})

const NOW = new Date('2026-11-19T12:00:00Z')

describe('the alert for a stopped line at the top of the board', () => {
  it('says what is red, for how long, and links the one fix', () => {
    render(<LineAlerts now={NOW} lines={[line()]} />)

    expect(screen.getByRole('alert').textContent).toBe(
      'usetheokit/theokit: the line has been stopped for 2h, workspace -> develop is red. Nothing else runs or integrates there until it is green. Fix #2400',
    )
    expect(screen.getByRole('link').getAttribute('href')).toBe(
      'https://github.com/usetheokit/theokit/issues/2400',
    )
  })

  it('counts the attempt once the first fix did not turn it green', () => {
    render(<LineAlerts now={NOW} lines={[line({ attempts: 2 })]} />)

    expect(screen.getByRole('link').textContent).toBe('Fix #2400, attempt 2')
  })

  it('says a person has it once the fixes ran out', () => {
    render(<LineAlerts now={NOW} lines={[line({ status: 'escalated' })]} />)

    expect(screen.getByRole('link').textContent).toBe('#2400 needs a person')
  })

  it('shows nothing while every line runs', () => {
    render(<LineAlerts lines={[]} />)

    expect(screen.queryByRole('alert')).toBeNull()
  })
})

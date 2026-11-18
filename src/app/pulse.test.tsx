// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MetricsReport, PulseReport } from '../shared/panel'

import { Pulse } from './components/Pulse'

const pulse: PulseReport = {
  deliveredLastHour: 5,
  deliveredLast24Hours: 48,
  leadTimeP50Minutes: 190,
  queued: 45,
  working: 8,
}

const metrics: MetricsReport = {
  rows: [
    {
      metric: 'change_failure',
      label: 'x',
      unit: 'share',
      worse: 'up',
      repository: '*',
      day: '2026-11-18',
      value: 0.3,
      samples: 20,
      mean: 0.1,
      sd: 0.02,
      band: 'act',
      rules: ['beyond_3sd'],
    },
  ],
  signals: [],
}

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = url.includes('/pulse') ? pulse : metrics
      return new Response(JSON.stringify(body), { status: 200 })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the metrics at the top of the board', () => {
  it('starts closed, with the first numbers of speed, efficiency and quality on one line', async () => {
    render(<Pulse />)

    const toggle = await screen.findByRole('button', { name: 'Show metrics' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByText('Speed')).toBeTruthy()
    expect(screen.getByText('Delivered in the last hour')).toBeTruthy()
    expect(screen.queryByText('Queued')).toBeNull()
  })

  it('opens to every number, says which daily one left its range, and remembers it is open', async () => {
    const first = render(<Pulse />)
    fireEvent.click(await screen.findByRole('button', { name: 'Show metrics' }))

    expect(screen.getByRole('button', { name: 'Hide metrics' })).toBeTruthy()
    expect(screen.getByText('Queued')).toBeTruthy()
    expect(document.querySelector('[data-pulse="leadTime"]')?.textContent).toContain('3h 10m')
    expect(document.querySelector('[data-pulse="change_failure"]')?.textContent).toContain(
      'out of its usual range',
    )
    first.unmount()

    render(<Pulse />)
    expect(await screen.findByRole('button', { name: 'Hide metrics' })).toBeTruthy()
  })
})

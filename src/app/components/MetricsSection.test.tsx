// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MetricsReport } from '../../shared/panel'

import { MetricsSection } from './MetricsSection'

const report = (extra: Partial<MetricsReport>): MetricsReport => ({
  rows: [],
  signals: [],
  ...extra,
})

function answer(body: MetricsReport) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  )
}

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the builder sessions a conflict started', () => {
  it('says how many ran in the last 14 days and in the 14 before', async () => {
    answer(report({ conflictSessions: { last14Days: 2, previous14Days: 14 } }))

    render(<MetricsSection />)

    const line = await screen.findByText(/Builder sessions started by a conflict/)
    expect(line.textContent).toContain('2 in the last 14 days')
    expect(line.textContent).toContain('14 in the 14 before')
  })

  it('says nothing when the report has no count', async () => {
    answer(report({}))

    render(<MetricsSection />)

    await screen.findByText(/Not enough finished work/)
    expect(screen.queryByText(/Builder sessions started by a conflict/)).toBeNull()
  })
})

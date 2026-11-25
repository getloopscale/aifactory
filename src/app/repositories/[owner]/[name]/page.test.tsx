// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RepositoryDetail } from '../../../../shared/panel'
import { CopyProvider, LANGUAGE_KEY } from '../../../lib/copy'
import { en } from '../../../lib/copy/en'

import Page from './page'

const empty: RepositoryDetail = {
  repository: 'paulo/app',
  tasks: [],
  passes: [],
  findings: [],
  patterns: [],
  indicators: [],
  costByRole: [],
  reviewRounds: [],
}

function show(body: RepositoryDetail) {
  window.localStorage.setItem(LANGUAGE_KEY, 'en')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  )
  return render(
    <MemoryRouter initialEntries={['/repositories/paulo/app']}>
      <CopyProvider>
        <Routes>
          <Route path="/repositories/:owner/:name" element={<Page />} />
        </Routes>
      </CopyProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.unstubAllGlobals()
})

describe('the page of one repository', () => {
  it('shows an empty state for each section when nothing happened', async () => {
    show(empty)
    const c = en.repositoryDetail
    for (const text of [
      c.noTasks,
      c.noPasses,
      c.noFindings,
      c.noPatterns,
      c.noIndicators,
      c.noCost,
      c.noReviews,
    ]) {
      expect(await screen.findByText(text)).toBeTruthy()
    }
    expect(screen.queryByText(c.notFound)).toBeNull()
  })

  it('shows an unknown cost as unknown and a missing day as a gap', async () => {
    show({
      ...empty,
      passes: [
        {
          id: 1,
          taskId: 7,
          issueNumber: 12,
          role: 'builder',
          harness: 'claude',
          model: null,
          durationMs: 2000,
          costUsd: null,
          ok: true,
          at: new Date().toISOString(),
        },
      ],
      indicators: [
        {
          metric: 'rework_rounds',
          label: 'Rework',
          unit: 'count',
          days: [
            { day: '2026-11-23', value: 1, samples: 4 },
            { day: '2026-11-24', value: null, samples: null },
          ],
        },
      ],
    })
    expect(await screen.findByText(en.repositoryDetail.unknownCost)).toBeTruthy()
    expect(screen.getByText(en.repositoryDetail.gap)).toBeTruthy()
    expect(screen.getByRole('link', { name: '#12' }).getAttribute('href')).toBe('/tasks/7')
  })
})

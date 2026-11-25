// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ReviewPatternView } from '../../shared/knowledge'
import { CopyProvider, LANGUAGE_KEY } from '../lib/copy'

import { ReviewPatterns } from './ReviewPatterns'

const pattern = (over: Partial<ReviewPatternView> = {}): ReviewPatternView => ({
  id: 4,
  repository: 'acme/app',
  className: 'input validated outside the route',
  tasks: [
    { id: 1, issueNumber: 11 },
    { id: 2, issueNumber: 12 },
    { id: 3, issueNumber: 13 },
  ],
  noted: true,
  proposalUrl: null,
  countBefore: null,
  countAfter: null,
  ...over,
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function show(list: ReviewPatternView[]) {
  window.localStorage.setItem(LANGUAGE_KEY, 'en')
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'POST'
      ? new Response(JSON.stringify({ url: 'https://github.com/o/k/pull/9' }), { status: 200 })
      : new Response(JSON.stringify(list), { status: 200 }),
  )
  vi.stubGlobal('fetch', fetcher)
  render(
    <CopyProvider>
      <ReviewPatterns repository="acme/app" />
    </CopyProvider>,
  )
  return fetcher
}

describe('ReviewPatterns', () => {
  it('lists the class, its tasks and the counts once measured', async () => {
    show([pattern({ countBefore: 3, countAfter: 1 })])
    expect(await screen.findByText('input validated outside the route')).toBeTruthy()
    expect(screen.getByText('#11, #12, #13')).toBeTruthy()
    expect(screen.getByText(/: 3 .*: 1/)).toBeTruthy()
  })

  it('proposes a rule and shows the pull request', async () => {
    const fetcher = show([pattern()])
    fireEvent.click(await screen.findByRole('button', { name: 'Propose as a rule' }))
    await waitFor(() => expect(screen.getByText('https://github.com/o/k/pull/9')).toBeTruthy())
    expect(fetcher).toHaveBeenCalledWith(
      '/api/panel/review-patterns/propose',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})

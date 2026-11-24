// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LinearCard } from './LinearCard'

afterEach(() => vi.restoreAllMocks())

describe('LinearCard', () => {
  it('saves the label and the team mapping the owner typed', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init })
        return Response.json({ settings: null })
      }),
    )
    render(<LinearCard />)
    fireEvent.change(screen.getByLabelText('Label id'), { target: { value: 'L1' } })
    fireEvent.click(screen.getByText('Map another team'))
    fireEvent.change(screen.getByLabelText('Team id'), { target: { value: 'T1' } })
    fireEvent.change(screen.getByLabelText('Repository (owner/name)'), { target: { value: 'o/r' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PUT')).toBe(true))
    const put = calls.find((c) => c.init?.method === 'PUT')!
    expect(put.url).toBe('/api/panel/linear')
    expect(JSON.parse(String(put.init?.body))).toEqual({ labelId: 'L1', teams: { T1: 'o/r' } })
  })
})

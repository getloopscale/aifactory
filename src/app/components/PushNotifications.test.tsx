// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { en } from '../lib/copy/en'

import { PushNotifications } from './PushNotifications'

const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) =>
      path.endsWith('/key')
        ? answer({ configured: false })
        : answer({ configured: false, devices: [] }),
    ),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('PushNotifications', () => {
  it('says it is not configured, with no button to turn it on', async () => {
    render(<PushNotifications />)
    await waitFor(() => expect(screen.getByText(en.setup.push.notConfigured)).toBeTruthy())
    expect(screen.queryByText(en.setup.push.turnOn)).toBeNull()
    expect(screen.getByText(en.setup.push.notConfiguredHelp)).toBeTruthy()
  })

  it('says the browser cannot receive them when it has no push support', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) =>
        path.endsWith('/key')
          ? answer({ configured: true, publicKey: 'AAAA' })
          : answer({
              configured: true,
              devices: [{ id: 1, label: 'Chrome on Linux', createdAt: 'x', lastSuccessAt: null }],
            }),
      ),
    )
    render(<PushNotifications />)
    await waitFor(() => expect(screen.getByText(en.setup.push.unsupported)).toBeTruthy())
    expect(screen.getByText('Chrome on Linux')).toBeTruthy()
    expect(screen.getByText(en.setup.push.remove)).toBeTruthy()
  })
})

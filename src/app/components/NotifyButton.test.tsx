// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CopyProvider, LANGUAGE_KEY } from '../lib/copy'
import { en } from '../lib/copy/en'

import { NotifyButton } from './NotifyButton'

window.localStorage.setItem(LANGUAGE_KEY, 'en')
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function fake(permission: NotificationPermission, answer: NotificationPermission = 'granted') {
  const requestPermission = vi.fn(async () => answer)
  vi.stubGlobal('Notification', { permission, requestPermission })
  return requestPermission
}
const show = () => render(<NotifyButton />, { wrapper: CopyProvider })

describe('the notify button', () => {
  it('asks only when clicked', async () => {
    const ask = fake('default')
    show()
    expect(ask).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.attention.notify }))
    await waitFor(() => expect(screen.getByText(en.attention.notifyOn)).toBeDefined())
    expect(ask).toHaveBeenCalledOnce()
  })

  it('shows the button off, with where to allow it, after a refusal', () => {
    fake('denied')
    show()
    expect(screen.getByRole('button', { name: en.attention.notify }).hasAttribute('disabled')).toBe(
      true,
    )
    expect(screen.getByText(en.attention.notifyDenied)).toBeDefined()
  })

  it('says so when the browser has no notifications', () => {
    vi.stubGlobal('Notification', undefined)
    show()
    expect(screen.getByText(en.attention.notifyUnsupported)).toBeDefined()
  })
})

describe('requestPermission call sites', () => {
  it('is called only by the two buttons', () => {
    const found: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) {
          if (readFileSync(path, 'utf8').includes('requestPermission(')) found.push(path)
        }
      }
    }
    walk(join(__dirname, '..'))
    expect(found.map((f) => f.split('/').pop())).toEqual(['NotifyButton.tsx', 'PushNotifications.tsx'])
  })
})

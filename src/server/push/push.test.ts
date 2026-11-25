import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendNotification = vi.fn()
vi.mock('web-push', () => ({
  default: { sendNotification: (...a: unknown[]) => sendNotification(...a) },
}))

import { pushConfig } from './config'
import { isGone, webPushSender } from './send'

const SECRET = 'PRIVATE-KEY-DO-NOT-LEAK'
const env = {
  FACTORY_PUSH_PUBLIC_KEY: 'pub',
  FACTORY_PUSH_PRIVATE_KEY: SECRET,
  FACTORY_PANEL_ORIGIN: 'https://panel.example/some/path',
}
const target = { endpoint: 'https://push.example/1', p256dh: 'a', auth: 'b' }
const payload = { title: 't', body: 'b', url: 'u', tag: 'x' }

beforeEach(() => {
  sendNotification.mockReset()
})

describe('pushConfig', () => {
  it('is off without any of the three variables', () => {
    expect(pushConfig({})).toBeNull()
    expect(pushConfig({ ...env, FACTORY_PUSH_PRIVATE_KEY: '' })).toBeNull()
    expect(pushConfig({ ...env, FACTORY_PANEL_ORIGIN: undefined })).toBeNull()
  })
  it('wants an HTTPS origin', () => {
    expect(pushConfig({ ...env, FACTORY_PANEL_ORIGIN: 'http://panel.example' })).toBeNull()
    expect(pushConfig(env)?.origin).toBe('https://panel.example')
  })
})

describe('webPushSender', () => {
  it('reports a gone endpoint by its status, with nothing of the error', async () => {
    sendNotification.mockImplementation(async () => {
      throw Object.assign(new Error(`failed with ${SECRET}`), {
        statusCode: 410,
        headers: { SECRET },
      })
    })
    const result = await webPushSender(pushConfig(env)!)(target, payload)
    expect(isGone(result)).toBe(true)
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })
  it('treats another failure as retryable', async () => {
    sendNotification.mockImplementation(async () => {
      throw new Error(SECRET)
    })
    const result = await webPushSender(pushConfig(env)!)(target, payload)
    expect(result.ok).toBe(false)
    expect(isGone(result)).toBe(false)
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })
})

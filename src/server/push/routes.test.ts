import { evaluateRoutePolicy, type RoutePolicy } from 'theokit/server/define'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GET as list } from '../routes/panel/push'
import { GET as key } from '../routes/panel/push/key'
import { POST as subscribe } from '../routes/panel/push/subscribe'
import { POST as test } from '../routes/panel/push/test'
import { POST as unsubscribe } from '../routes/panel/push/unsubscribe'

const SECRET = 'PRIVATE-KEY-DO-NOT-LEAK'
const input = (subject: { id: string } | null) => ({ subject, query: {}, body: {}, params: {} })

afterEach(() => vi.unstubAllEnvs())

describe('the push routes', () => {
  it.each([
    ['key', key],
    ['list', list],
    ['subscribe', subscribe],
    ['unsubscribe', unsubscribe],
    ['test', test],
  ])('%s is for the owner only', async (_name, route) => {
    const policy = route.policy as RoutePolicy<unknown, unknown, unknown>
    expect(await evaluateRoutePolicy(policy, input(null))).toMatchObject({ allowed: false })
    expect(await evaluateRoutePolicy(policy, input({ id: 'owner' }))).toEqual({ allowed: true })
  })

  it('says push is not configured without the keys', async () => {
    vi.stubEnv('FACTORY_PUSH_PUBLIC_KEY', '')
    vi.stubEnv('FACTORY_PUSH_PRIVATE_KEY', '')
    vi.stubEnv('FACTORY_PANEL_ORIGIN', '')
    const handler = key.handler as unknown as () => unknown
    expect(await handler()).toEqual({ configured: false })
  })

  it('answers the public key and never the private one', async () => {
    vi.stubEnv('FACTORY_PUSH_PUBLIC_KEY', 'pub')
    vi.stubEnv('FACTORY_PUSH_PRIVATE_KEY', SECRET)
    vi.stubEnv('FACTORY_PANEL_ORIGIN', 'https://panel.example')
    const handler = key.handler as unknown as () => unknown
    const body = JSON.stringify(await handler())
    expect(body).toContain('pub')
    expect(body).not.toContain(SECRET)
  })

  it('refuses to subscribe an address that is not a push service', () => {
    const schema = subscribe.body as { safeParse: (v: unknown) => { success: boolean } }
    const keys = { p256dh: 'a', auth: 'b' }
    expect(schema.safeParse({ endpoint: 'https://fcm.googleapis.com/x', keys }).success).toBe(true)
    for (const endpoint of [
      'http://169.254.169.254/',
      'https://localhost/x',
      'https://10.0.0.1/x',
    ]) {
      expect(schema.safeParse({ endpoint, keys }).success).toBe(false)
    }
    const remove = unsubscribe.body as { safeParse: (v: unknown) => { success: boolean } }
    expect(remove.safeParse({ endpoint: 'https://localhost/x' }).success).toBe(false)
  })
})

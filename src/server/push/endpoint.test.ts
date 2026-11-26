import { describe, expect, it } from 'vitest'

import { isPushEndpoint } from './endpoint'

describe('isPushEndpoint', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/abc',
    'https://wns2-par02p.notify.windows.com/w/?token=x',
  ])('accepts %s', (url) => expect(isPushEndpoint(url)).toBe(true))

  it.each([
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://localhost/x',
    'https://127.0.0.1/x',
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.5/x',
    'https://[::1]/x',
    'https://fcm.googleapis.com.evil.example/x',
    'https://evilfcm.googleapis.com.example/x',
    'https://notfcm.googleapis.com@127.0.0.1/x',
    'https://user:pw@fcm.googleapis.com/x',
    'https://fcm.googleapis.com:8443/x',
    'https://evil-push.apple.com.example/x',
    'file:///etc/passwd',
    'not a url',
  ])('refuses %s', (url) => expect(isPushEndpoint(url)).toBe(false))
})

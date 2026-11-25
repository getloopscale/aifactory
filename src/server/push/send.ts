import webpush from 'web-push'

import type { PushPayload } from '../../shared/push'

import type { PushConfig } from './config'

export type PushTarget = { endpoint: string; p256dh: string; auth: string }

/** What a send came to. `status` is the push service's HTTP status, when it answered. */
export type SendResult = { ok: true } | { ok: false; status?: number; reason: string }

export type PushSender = (target: PushTarget, payload: PushPayload) => Promise<SendResult>

/**
 * The only module that calls the network. An error is reduced to its status and a short reason: the
 * library's error carries the request, and the request carries the keys.
 */
export function webPushSender(config: PushConfig): PushSender {
  return async (target, payload) => {
    try {
      await webpush.sendNotification(
        { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        JSON.stringify(payload),
        {
          vapidDetails: {
            subject: config.origin,
            publicKey: config.publicKey,
            privateKey: config.privateKey,
          },
          TTL: 60 * 60 * 24,
        },
      )
      return { ok: true }
    } catch (error) {
      const status = (error as { statusCode?: unknown }).statusCode
      return {
        ok: false,
        status: typeof status === 'number' ? status : undefined,
        reason: typeof status === 'number' ? `push service answered ${status}` : 'send failed',
      }
    }
  }
}

/** The subscription is gone for good: the push service says the endpoint no longer exists. */
export const isGone = (result: SendResult) =>
  !result.ok && (result.status === 404 || result.status === 410)

import { z } from 'zod'

/**
 * The push services browsers use. The server POSTs to a subscription's endpoint, and the endpoint comes from
 * the request body, so only these hosts are accepted: a name an attacker cannot point at an internal address.
 */
const PUSH_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'notify.windows.com',
  'push.apple.com',
]

/** True for an `https` address, with no credentials or port, on a push service's host or one of its subdomains. */
export function isPushEndpoint(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
  const host = url.hostname.toLowerCase()
  return PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
}

export const PushEndpoint = z
  .string()
  .max(2048)
  .refine(isPushEndpoint, { message: 'not the address of a known push service' })

export type PushConfig = { publicKey: string; privateKey: string; origin: string }

/**
 * Push is on only with the three variables and an HTTPS origin. Without them nothing is sent and the
 * routes say it is not configured. The private key stays in this object: it is never logged or returned.
 */
export function pushConfig(env: NodeJS.ProcessEnv = process.env): PushConfig | null {
  const publicKey = env.FACTORY_PUSH_PUBLIC_KEY?.trim()
  const privateKey = env.FACTORY_PUSH_PRIVATE_KEY?.trim()
  const raw = env.FACTORY_PANEL_ORIGIN?.trim()
  if (!publicKey || !privateKey || !raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:') return null
    return { publicKey, privateKey, origin: url.origin }
  } catch {
    return null
  }
}

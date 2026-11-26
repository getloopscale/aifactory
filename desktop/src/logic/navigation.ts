export type Navigation = 'stay' | 'external' | 'refuse'

/** Where a navigation goes: the panel's origin stays, another web origin is the system browser's, anything else is refused. */
export function navigationFor(target: string, panelOrigin: string): Navigation {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return 'refuse'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'refuse'
  return url.origin === panelOrigin ? 'stay' : 'external'
}

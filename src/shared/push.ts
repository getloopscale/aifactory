/** What the panel's push routes answer. No private key ever appears in these. */
export type PushKey = { configured: false } | { configured: true; publicKey: string }

export type PushDevice = {
  id: number
  label: string
  createdAt: string
  lastSuccessAt: string | null
}

export type PushDevices = { configured: boolean; devices: PushDevice[] }

/** What a browser's `PushSubscription.toJSON()` holds, as the subscribe route takes it. */
export type PushSubscribeBody = {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

/** The notification the worker shows. */
export type PushPayload = { title: string; body: string; url: string; tag: string }

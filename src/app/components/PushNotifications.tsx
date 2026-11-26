import { Badge, Button } from '@usetheo/ui'
import { useCallback, useEffect, useState } from 'react'

import type { PushDevices, PushKey } from '../../shared/push'
import { get, post } from '../lib/api'
import { useCopy } from '../lib/copy'

type State = 'loading' | 'unsupported' | 'not_configured' | 'denied' | 'off' | 'on'

const supported = () =>
  typeof navigator !== 'undefined' &&
  'serviceWorker' in navigator &&
  typeof window !== 'undefined' &&
  'PushManager' in window &&
  'Notification' in window

/** The VAPID key as the bytes `subscribe` wants. */
function keyBytes(key: string): Uint8Array {
  const padded = (key + '='.repeat((4 - (key.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/')
  const raw = atob(padded)
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

const registration = () => navigator.serviceWorker.ready

/**
 * Web Push on this device: turn it on or off, send a test, and see or remove the devices subscribed. The
 * browser holds the subscription; the server keeps its address and keys, and only the public key reaches here.
 */
export function PushNotifications() {
  const { t } = useCopy()
  const c = t.setup.push
  const [state, setState] = useState<State>('loading')
  const [key, setKey] = useState<PushKey>()
  const [devices, setDevices] = useState<PushDevices['devices']>([])
  const [message, setMessage] = useState<string>()
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const k = await get<PushKey>('/api/panel/push/key')
      setKey(k)
      const list = await get<PushDevices>('/api/panel/push')
      setDevices(list.devices)
      if (!k.configured) return setState('not_configured')
      if (!supported()) return setState('unsupported')
      if (Notification.permission === 'denied') return setState('denied')
      const existing = await (await registration()).pushManager.getSubscription()
      setState(existing ? 'on' : 'off')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
      setState(supported() ? 'off' : 'unsupported')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function run(work: () => Promise<void>) {
    setBusy(true)
    setMessage(undefined)
    try {
      await work()
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const turnOn = () =>
    run(async () => {
      if (!key?.configured) return
      if ((await Notification.requestPermission()) !== 'granted') return
      const sub = await (
        await registration()
      ).pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(key.publicKey) as BufferSource,
      })
      await post('/api/panel/push/subscribe', sub.toJSON())
    })

  const turnOff = () =>
    run(async () => {
      const sub = await (await registration()).pushManager.getSubscription()
      if (!sub) return
      await post('/api/panel/push/unsubscribe', { endpoint: sub.endpoint })
      await sub.unsubscribe()
    })

  const test = () =>
    run(async () => {
      const result = await post<{ sent: number }>('/api/panel/push/test')
      setMessage(c.testResult(result.sent))
    })

  const remove = (id: number) =>
    run(async () => {
      await post('/api/panel/push/unsubscribe', { id })
    })

  if (state === 'loading') return null
  const tone = state === 'on' ? 'success' : state === 'not_configured' ? 'warning' : 'outline'
  const status = state === 'on' ? c.on : state === 'not_configured' ? c.notConfigured : c.off
  return (
    <section
      aria-label={c.label}
      className="space-y-2 rounded-lg border border-border bg-card p-3 text-sm"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Badge variant={tone} className="whitespace-nowrap">
          {status}
        </Badge>
        <span className="font-medium">{c.label}</span>
        {state === 'off' ? (
          <Button size="sm" className="ml-auto" disabled={busy} onClick={turnOn}>
            {c.turnOn}
          </Button>
        ) : null}
        {state === 'on' ? (
          <span className="ml-auto flex gap-2">
            <Button size="sm" variant="secondary" disabled={busy} onClick={test}>
              {c.sendTest}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={turnOff}>
              {c.turnOff}
            </Button>
          </span>
        ) : null}
      </div>
      {state === 'unsupported' ? <p className="text-muted-foreground">{c.unsupported}</p> : null}
      {state === 'not_configured' ? (
        <p className="text-muted-foreground">{c.notConfiguredHelp}</p>
      ) : null}
      {state === 'denied' ? <p className="text-muted-foreground">{c.denied}</p> : null}
      {message ? <p role="status">{message}</p> : null}
      {state !== 'not_configured' ? (
        <div>
          <h3 className="font-medium">{c.devices}</h3>
          {devices.length === 0 ? (
            <p className="text-muted-foreground">{c.noDevices}</p>
          ) : (
            <ul className="space-y-1">
              {devices.map((d) => (
                <li key={d.id} className="flex items-center gap-3">
                  <span>{d.label}</span>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="ml-auto"
                    disabled={busy}
                    onClick={() => remove(d.id)}
                  >
                    {c.remove}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  )
}

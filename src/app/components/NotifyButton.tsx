import { Button } from '@usetheo/ui'
import { useState } from 'react'

import { useCopy } from '../lib/copy'

type Permission = NotificationPermission | 'unsupported'

const current = (): Permission =>
  typeof Notification === 'undefined' ? 'unsupported' : Notification.permission

/** The only place that asks the browser for permission to notify: never on load, only from a click. */
export function NotifyButton() {
  const { t } = useCopy()
  const [permission, setPermission] = useState<Permission>(current)
  const ask = () => {
    void Promise.resolve(Notification.requestPermission())
      .then(setPermission)
      .catch(() => setPermission(current()))
  }
  if (permission === 'unsupported') {
    return <p className="text-sm text-muted-foreground">{t.attention.notifyUnsupported}</p>
  }
  if (permission === 'denied') {
    return (
      <div className="space-y-1">
        <Button size="sm" variant="secondary" disabled aria-pressed="false">
          {t.attention.notify}
        </Button>
        <p className="text-sm text-muted-foreground">{t.attention.notifyDenied}</p>
      </div>
    )
  }
  if (permission === 'granted') {
    return <p className="text-sm text-muted-foreground">{t.attention.notifyOn}</p>
  }
  return (
    <Button size="sm" variant="secondary" onClick={ask}>
      {t.attention.notify}
    </Button>
  )
}

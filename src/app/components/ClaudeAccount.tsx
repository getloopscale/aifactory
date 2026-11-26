import { Button, Input } from '@usetheo/ui'
import { useEffect, useState } from 'react'

import type { ClaudeLoginState } from '../../shared/panel'
import { del, get, post } from '../lib/api'
import { useCopy } from '../lib/copy'

import { RetryWaiting } from './RetryWaiting'

/**
 * Changing the Claude Code account without leaving the panel. The owner opens a link signed in to the
 * account they want, copies the code the page shows, and pastes it here; the panel checks that the account
 * really answers before it keeps anything. The token never comes back to the page.
 */
export function ClaudeAccount({ onChanged }: { onChanged: () => void }) {
  const { t } = useCopy()
  const c = t.account.claude
  const [login, setLogin] = useState<ClaudeLoginState>({ status: 'idle' })
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  // A login started before the page was reloaded is still waiting for its code.
  useEffect(() => {
    let alive = true
    get<ClaudeLoginState>('/api/panel/claude/login')
      .then((state) => alive && setLogin(state))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  async function act(run: () => Promise<ClaudeLoginState>) {
    setBusy(true)
    try {
      const next = await run()
      setLogin(next)
      if (next.status === 'done') onChanged()
    } catch (error) {
      setLogin({ status: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const start = () => act(() => post<ClaudeLoginState>('/api/panel/claude/login'))
  const cancel = () => {
    setCode('')
    return act(() => del<ClaudeLoginState>('/api/panel/claude/login'))
  }
  const send = () =>
    act(async () => {
      const next = await post<ClaudeLoginState>('/api/panel/claude/login/code', { code })
      setCode('')
      return next
    })

  return (
    <section aria-label={c.label} className="rounded-md bg-muted/40 p-3 text-sm">
      {login.status === 'idle' ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-muted-foreground">{c.idle}</p>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void start()}>
            {t.account.signInOther}
          </Button>
        </div>
      ) : null}

      {login.status === 'waiting' ? (
        <ol className="space-y-3">
          <li>
            <span className="font-medium">1.</span> {c.step1}{' '}
            <Button asChild size="sm" className="ml-1">
              <a href={login.url} target="_blank" rel="noreferrer">
                {c.openLogin}
              </a>
            </Button>
          </li>
          <li>
            <span className="font-medium">2.</span> {c.step2}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Input
                aria-label={c.codeLabel}
                value={code}
                placeholder={c.codePlaceholder}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setCode(e.target.value)}
                className="min-w-72 flex-1 font-mono"
              />
              <Button size="sm" disabled={busy || code.trim() === ''} onClick={() => void send()}>
                {c.connect}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void cancel()}>
                {t.account.cancel}
              </Button>
            </div>
          </li>
        </ol>
      ) : null}

      {login.status === 'checking' ? (
        <p role="status" className="text-muted-foreground">
          {t.account.checking(t.account.oneMinute)}
        </p>
      ) : null}

      {login.status === 'done' ? (
        <div className="space-y-2">
          <p role="status" className="text-foreground">
            {c.done}
          </p>
          <RetryWaiting />
        </div>
      ) : null}

      {login.status === 'error' ? (
        <div className="space-y-2">
          <p role="alert" className="text-destructive">
            {login.message}
          </p>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void start()}>
            {t.account.tryAgain}
          </Button>
        </div>
      ) : null}
    </section>
  )
}

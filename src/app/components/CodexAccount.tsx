import { Button } from '@usetheo/ui'
import { useEffect, useState } from 'react'

import type { CodexConnection } from '../../shared/panel'
import { del, get, post } from '../lib/api'
import { useCopy } from '../lib/copy'

import { RetryWaiting } from './RetryWaiting'

const LOGIN_URL = '/api/panel/codex/login'
const failed = (error: unknown): CodexConnection => ({
  account: { connected: false },
  login: { status: 'error', message: error instanceof Error ? error.message : String(error) },
})

/**
 * Changing the factory's Codex account without leaving the panel. The owner opens an address signed in to
 * the ChatGPT account they want and types the code shown here; the page asks every few seconds how it went.
 * The panel checks that the account answers before it keeps it, and no token ever reaches the page.
 */
export function CodexAccount({ onChanged }: { onChanged: () => void }) {
  const { t } = useCopy()
  const c = t.account.codex
  const [conn, setConn] = useState<CodexConnection>()
  const [busy, setBusy] = useState(false)
  const status = conn?.login.status

  useEffect(() => {
    let alive = true
    get<CodexConnection>(LOGIN_URL)
      .then((next) => alive && setConn(next))
      .catch((error: unknown) => alive && setConn(failed(error)))
    return () => {
      alive = false
    }
  }, [])

  // While the owner approves, and while the account is checked, the page asks how it is going.
  useEffect(() => {
    if (status !== 'waiting' && status !== 'checking') return
    const timer = setInterval(() => {
      get<CodexConnection>(LOGIN_URL)
        .then((next) => {
          setConn(next)
          if (next.login.status === 'done') onChanged()
        })
        .catch((error: unknown) => setConn(failed(error)))
    }, 3000)
    return () => clearInterval(timer)
  }, [status, onChanged])

  async function act(run: () => Promise<CodexConnection>) {
    setBusy(true)
    try {
      setConn(await run())
    } catch (error) {
      setConn(failed(error))
    } finally {
      setBusy(false)
    }
  }
  const start = () => act(() => post<CodexConnection>(LOGIN_URL))
  const cancel = () => act(() => del<CodexConnection>(LOGIN_URL))

  if (!conn) return null
  const { account, login } = conn

  return (
    <section aria-label={c.label} className="rounded-lg border border-border bg-card p-3 text-sm">
      {login.status === 'idle' ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-muted-foreground">
            {account.connected
              ? c.connected(account.email, account.plan)
              : account.problem
                ? c.unusable(account.problem)
                : c.noAccount}
          </p>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void start()}>
            {account.connected ? t.account.signInOther : c.connect}
          </Button>
        </div>
      ) : null}

      {login.status === 'waiting' ? (
        <div className="space-y-2">
          <p>
            {c.open}{' '}
            <a href={login.verificationUri} target="_blank" rel="noreferrer" className="underline">
              {login.verificationUri}
            </a>{' '}
            {c.thenType} <strong className="font-mono tracking-wider">{login.userCode}</strong>.{' '}
            {c.waitHint}
          </p>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void cancel()}>
            {t.account.cancel}
          </Button>
        </div>
      ) : null}

      {login.status === 'checking' ? (
        <p role="status" className="text-muted-foreground">
          {t.account.checking(t.account.twoMinutes)}
        </p>
      ) : null}

      {login.status === 'done' ? (
        <div className="space-y-2">
          <p role="status" className="text-foreground">
            {c.done(account.connected ? account.email : undefined)}
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

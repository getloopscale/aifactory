import { useState, type FormEvent } from 'react'

import { Button, Input } from '@usetheo/ui'

import { post } from '../lib/api'
import { useCopy } from '../lib/copy'

export default function LoginPage() {
  const { t } = useCopy()
  const [token, setToken] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      await post('/api/panel/login', { token })
      window.location.assign('/')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="mx-auto mt-16 max-w-sm space-y-3">
      <h1 className="text-xl font-semibold">{t.login.title}</h1>
      <label className="block text-sm">
        <span className="text-foreground">{t.login.token}</span>
        <Input
          type="password"
          autoComplete="current-password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="mt-1 w-full"
        />
      </label>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={busy || token === ''}>
        {t.login.submit}
      </Button>
    </form>
  )
}

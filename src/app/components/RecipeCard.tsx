import { Alert, Badge, Button } from '@usetheo/ui'
import { FileCog } from 'lucide-react'
import { useState } from 'react'

import type { RecipeView } from '../../shared/panel'
import { post } from '../lib/api'
import { useCopy } from '../lib/copy'
import { useResource } from '../lib/live'

import { READABLE } from './ui/Surface'

/**
 * What the project's `.factory/setup.json` asks for, read from its default branch. The panel's own
 * settings above win over it. Its domains reach the sandbox only once approved here, and the card shows
 * which ones would open before the owner says yes.
 */
export function RecipeCard({ fullName }: { fullName: string }) {
  const { t } = useCopy()
  const resource = useResource<RecipeView>(`/api/panel/repositories/${fullName}/recipe`, {
    stream: false,
    everyMs: 120_000,
  })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()
  const view = resource.data

  async function approve(domains: string[]) {
    setBusy(true)
    setMessage(undefined)
    try {
      await post(`/api/panel/repositories/${fullName}/recipe`, { approve: domains })
      resource.reload()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (resource.error) return <p className="text-sm text-destructive">{resource.error}</p>
  if (!view) return <p className="text-sm text-muted-foreground">{t.recipe.reading}</p>
  if (view.problem) {
    return <Alert intent="destructive" title={t.recipe.unusable} description={view.problem} />
  }
  if (!view.recipe) {
    return <p className="text-sm text-muted-foreground">{t.recipe.none}</p>
  }
  const { recipe } = view
  return (
    <section aria-label={t.recipe.label} className={`space-y-2 text-sm ${READABLE}`}>
      <div className="flex items-center gap-2">
        <FileCog aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{t.recipe.from}</h3>
      </div>
      {recipe.install ? (
        <p>
          {t.recipe.install} <code>{recipe.install}</code>
        </p>
      ) : null}
      {recipe.checks ? (
        <p>
          {t.recipe.checks}{' '}
          {recipe.checks.map((c) => (
            <code key={c.name} className="mr-2">
              {c.name}: {c.command}
            </code>
          ))}
        </p>
      ) : null}
      {recipe.egress.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {recipe.egress.map((domain) => (
            <li key={domain}>
              <Badge variant={view.pending.includes(domain) ? 'warning' : 'success'}>
                {domain} {view.pending.includes(domain) ? t.recipe.waits : t.recipe.open}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      {view.pending.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          <span>{t.recipe.alsoReach(view.pending.join(', '))}</span>
          <Button size="sm" disabled={busy} onClick={() => void approve(view.pending)}>
            {t.recipe.approve(view.pending.length)}
          </Button>
        </div>
      ) : null}
      {message ? (
        <p role="alert" className="text-destructive">
          {message}
        </p>
      ) : null}
    </section>
  )
}

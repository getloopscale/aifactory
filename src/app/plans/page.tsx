import { Alert, Badge, Button, Textarea } from '@usetheo/ui'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'

import type { PlanView, RepositoriesView } from '../../shared/panel'
import { post } from '../lib/api'
import { Assist } from '../components/Assist'
import { useCopy } from '../lib/copy'
import { money } from '../lib/format'
import { useResource } from '../lib/live'

const TONE = {
  planning: 'primary',
  ready: 'success',
  failed: 'destructive',
  created: 'accent',
} as const

/** Where a goal becomes a plan: pick a repository, say what you want, and an agent splits it into issues. */
export default function PlansPage() {
  const { t } = useCopy()
  const repos = useResource<RepositoriesView>('/api/panel/repositories', {
    everyMs: 60_000,
    stream: false,
  })
  const plans = useResource<{ plans: PlanView[] }>('/api/panel/plans', { everyMs: 5_000 })
  const navigate = useNavigate()
  const [repository, setRepository] = useState('')
  const [goal, setGoal] = useState('')
  const [message, setMessage] = useState<string>()
  const [busy, setBusy] = useState(false)

  const enabled = repos.data?.repositories.filter((r) => r.enabled) ?? []
  const chosen = repository || enabled[0]?.fullName || ''

  async function submit() {
    setBusy(true)
    setMessage(undefined)
    try {
      const { planId } = await post<{ planId: number }>('/api/panel/plans', {
        repository: chosen,
        goal,
      })
      void navigate(`/plans/${planId}`)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">{t.plans.heading}</h1>

      {repos.data && enabled.length === 0 ? (
        <Alert
          intent="info"
          title={t.plans.enableFirst}
          description={t.plans.enableFirstText}
          action={
            <Link to="/repositories" className="text-sm underline underline-offset-2">
              {t.plans.openRepositories}
            </Link>
          }
        />
      ) : (
        <section
          aria-label={t.plans.newPlan}
          className="space-y-3 rounded-lg border border-border bg-card p-4"
        >
          <h2 className="text-sm font-semibold">{t.plans.whatBuilt}</h2>
          <label className="block text-sm">
            <span className="text-foreground">{t.plans.repository}</span>
            <select
              aria-label={t.plans.repository}
              value={chosen}
              onChange={(e) => setRepository(e.target.value)}
              className="mt-1 h-9 w-full rounded-lg border border-border bg-card px-2 text-sm text-foreground"
            >
              {enabled.map((r) => (
                <option key={r.fullName}>{r.fullName}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-foreground">{t.plans.goal}</span>
            <Textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={4}
              placeholder={t.plans.goalPlaceholder}
              className="mt-1 w-full"
            />
          </label>
          <Assist kind="goal" text={goal} repository={chosen} onUse={(p) => setGoal(p.text)} />
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              disabled={busy || chosen === '' || goal.trim().length < 10}
              onClick={() => void submit()}
            >
              {t.plans.make}
            </Button>
            {message ? (
              <span role="alert" className="text-sm text-destructive">
                {message}
              </span>
            ) : null}
          </div>
        </section>
      )}

      <section aria-label={t.plans.earlier}>
        <h2 className="mb-2 text-sm font-semibold">{t.plans.earlier}</h2>
        {plans.data && plans.data.plans.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.plans.none}</p>
        ) : (
          <ul className="space-y-2">
            {(plans.data?.plans ?? []).map((p) => (
              <li key={p.id}>
                <Link
                  to={`/plans/${p.id}`}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3 text-sm hover:border-primary/60"
                >
                  <Badge variant={TONE[p.status]} className="whitespace-nowrap">
                    {t.plans.status[p.status]}
                  </Badge>
                  <span className="text-muted-foreground">{p.repository}</span>
                  <span className="min-w-0 flex-1 truncate text-foreground">{p.goal}</span>
                  <span className="text-xs text-muted-foreground">{money(p.costUsd)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

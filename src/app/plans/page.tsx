import { Alert, Badge, Button, Textarea } from '@getloopscale/ui'
import { ListTree, Target } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'

import type { PlanView, RepositoriesView } from '../../shared/panel'
import { post } from '../lib/api'
import { Assist } from '../components/Assist'
import {
  PageHeader,
  Pane,
  Quiet,
  READABLE,
  Row,
  RowIcon,
  Rows,
  Surface,
  type Tone,
  Workbench,
} from '../components/ui/Surface'
import { useCopy } from '../lib/copy'
import { money } from '../lib/format'
import { useResource } from '../lib/live'

const TONE = {
  planning: 'primary',
  ready: 'success',
  failed: 'destructive',
  created: 'accent',
} as const

/** The colour of the mark that starts a plan's row: being written, waiting to be read, failed, turned into issues. */
const ROW_TONE: Record<PlanView['status'], Tone> = {
  planning: 'primary',
  ready: 'warning',
  failed: 'destructive',
  created: 'success',
}

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
    <Workbench
      columns="grid-cols-[minmax(360px,5fr)_minmax(0,7fr)]"
      header={<PageHeader title={t.plans.heading} />}
    >
      <Pane>
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
          <Surface title={t.plans.whatBuilt} label={t.plans.newPlan} icon={Target} padded>
            <div className={`space-y-3 ${READABLE}`}>
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
            </div>
          </Surface>
        )}
      </Pane>
      <Pane>
        <Surface title={t.plans.earlier} icon={ListTree} count={plans.data?.plans.length}>
          {plans.data && plans.data.plans.length === 0 ? (
            <Quiet>{t.plans.none}</Quiet>
          ) : (
            <Rows>
              {(plans.data?.plans ?? []).map((p) => (
                <Row
                  key={p.id}
                  to={`/plans/${p.id}`}
                  lead={<RowIcon icon={ListTree} tone={ROW_TONE[p.status]} />}
                  title={p.goal}
                  meta={p.repository}
                  trail={
                    <>
                      <Badge variant={TONE[p.status]} className="whitespace-nowrap">
                        {t.plans.status[p.status]}
                      </Badge>
                      <span className="w-14 text-right font-mono tabular-nums">
                        {money(p.costUsd)}
                      </span>
                    </>
                  }
                />
              ))}
            </Rows>
          )}
        </Surface>
      </Pane>
    </Workbench>
  )
}

import { useState } from 'react'
import { Button } from '@usetheo/ui'
import { Link } from 'react-router'

import type { FindingView, HealthReport } from '../../shared/panel'
import { MetricsSection } from '../components/MetricsSection'
import { post } from '../lib/api'
import { useCopy } from '../lib/copy'
import { ago, money } from '../lib/format'
import { useResource } from '../lib/live'

type Action = 'retry' | 'resume' | 'delete_snapshot' | 'mark_revert_unknown'

/**
 * What a person does about each kind of finding; the words come from the dictionary. A stalled queue has nothing to
 * do from here: its detail says what holds it, and it resolves once its runs start.
 */
const ACTION: Record<Exclude<FindingView['subject'], 'queue'>, Action> = {
  run: 'retry',
  queued_run: 'retry',
  answer_resume: 'resume',
  snapshot: 'delete_snapshot',
  revert: 'mark_revert_unknown',
}

function FindingRow({ finding, onDone }: { finding: FindingView; onDone: () => void }) {
  const { t } = useCopy()
  const [message, setMessage] = useState<string>()
  const subject = finding.subject
  const todo: { label: string; confirm?: string } | undefined =
    subject === 'queue' ? undefined : t.health.actions[subject]

  async function resolve() {
    if (subject === 'queue' || !todo) return
    if (todo.confirm && !window.confirm(todo.confirm)) return
    try {
      await post(`/api/panel/findings/${finding.id}/resolve`, { action: ACTION[subject] })
      onDone()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <li className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          <span className="mr-2 rounded bg-warning/30 px-1.5 py-0.5 text-xs uppercase">
            {finding.kind}
          </span>
          {t.health.kind[finding.subject]}
        </span>
        <span className="text-xs text-muted-foreground">
          {t.health.since(ago(finding.firstSeenAt, Date.now(), t.time))}
        </span>
      </div>
      {finding.taskId !== null ? (
        <div className="mt-1 text-xs">
          <Link
            to={`/tasks/${finding.taskId}`}
            className="text-foreground underline underline-offset-2"
          >
            {finding.taskTitle ?? t.health.task(finding.taskId)}
          </Link>
        </div>
      ) : null}
      <p className="mt-1 text-foreground">{finding.detail}</p>
      {todo ? (
        <Button size="sm" variant="secondary" className="mt-2" onClick={() => void resolve()}>
          {todo.label}
        </Button>
      ) : null}
      {message ? (
        <p role="status" className="mt-2 text-destructive">
          {message}
        </p>
      ) : null}
    </li>
  )
}

/** Some runs reported a cost and some did not. */
const partlyReported = (g: { reportedRuns: number; runs: number }) =>
  g.reportedRuns !== 0 && g.reportedRuns < g.runs

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

export default function HealthPage() {
  const { t } = useCopy()
  const h = t.health
  const report = useResource<HealthReport>('/api/panel/health')
  const data = report.data
  return (
    <div className="space-y-8">
      <h1 className="text-xl font-semibold">{h.title}</h1>
      {report.error ? <p className="text-sm text-destructive">{report.error}</p> : null}
      {!data ? (
        <p className="text-sm text-muted-foreground">{h.loading}</p>
      ) : (
        <>
          <section aria-label={h.findings}>
            <h2 className="mb-2 text-sm font-semibold">{h.findings}</h2>
            {data.findings.length === 0 ? (
              <p className="text-sm text-muted-foreground">{h.nothingWrong}</p>
            ) : (
              <ul className="space-y-2">
                {data.findings.map((f) => (
                  <FindingRow key={f.id} finding={f} onDone={report.reload} />
                ))}
              </ul>
            )}
          </section>

          <section aria-label={h.cost.title}>
            <h2 className="mb-2 text-sm font-semibold">{h.cost.title}</h2>
            <dl className="grid grid-cols-4 gap-3 text-sm">
              {[
                [h.cost.last24, money(data.cost.last24HoursUsd)],
                [h.cost.last7, money(data.cost.last7DaysUsd)],
                [h.cost.allTime, money(data.cost.totalUsd)],
                [h.cost.perTask(data.cost.tasks), money(data.cost.avgPerTaskUsd)],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-border bg-card p-3">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="mt-1 text-lg font-semibold">{value}</dd>
                </div>
              ))}
            </dl>
            {data.cost.groups.length > 0 ? (
              <table className="mt-4 w-full text-left text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-3">{h.cost.agent}</th>
                    <th className="py-1 pr-3">{h.cost.role}</th>
                    <th className="py-1 pr-3">{h.cost.runs}</th>
                    <th className="py-1 pr-3">{h.cost.cost}</th>
                    <th className="py-1 pr-3">{h.cost.averageTime}</th>
                    <th className="py-1 pr-3">{h.cost.failed}</th>
                    <th className="py-1 pr-3">{h.cost.quota}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.cost.groups.map((g) => (
                    <tr key={`${g.harness}-${g.role}`} className="border-t border-border">
                      <td className="py-1 pr-3 font-medium">{g.harness}</td>
                      <td className="py-1 pr-3">{g.role}</td>
                      <td className="py-1 pr-3">{g.runs}</td>
                      <td className="py-1 pr-3">
                        {g.reportedRuns === 0 ? (
                          <span className="text-muted-foreground">{h.cost.notReported}</span>
                        ) : (
                          money(g.costUsd)
                        )}
                        {partlyReported(g) ? (
                          <span className="text-xs text-muted-foreground">
                            {' '}
                            {h.cost.partlyReported(g.reportedRuns, g.runs)}
                          </span>
                        ) : null}
                      </td>
                      <td className="py-1 pr-3">{seconds(g.avgDurationMs)}</td>
                      <td className="py-1 pr-3">{g.failed}</td>
                      <td className="py-1 pr-3">{g.quota}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">{h.cost.none}</p>
            )}
          </section>

          <MetricsSection />
        </>
      )}
    </div>
  )
}

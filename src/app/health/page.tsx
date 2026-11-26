import { useState } from 'react'
import { Button } from '@usetheo/ui'
import { CircleDollarSign, Stethoscope, TriangleAlert } from 'lucide-react'
import { Link } from 'react-router'

import type { FindingView, HealthReport } from '../../shared/panel'
import { AgentIcon } from '../components/floor/AgentIcon'
import { MetricsSection } from '../components/MetricsSection'
import {
  PageHeader,
  Quiet,
  Row,
  RowIcon,
  Rows,
  STACK,
  Stats,
  Surface,
  TABLE,
} from '../components/ui/Surface'
import { post } from '../lib/api'
import { useCopy } from '../lib/copy'
import { ago, money } from '../lib/format'
import { useResource } from '../lib/live'

type Action = 'retry' | 'resume' | 'delete_snapshot' | 'mark_revert_unknown'

/** The kinds of finding a person resolves from the panel. */
type Actionable = Exclude<FindingView['subject'], 'back_merge' | 'queue'>

/**
 * What a person does about each kind of finding; the words come from the dictionary. A stalled queue has
 * nothing to do from here: its detail says what holds it. A back-merge that
 * conflicts is resolved on GitHub, so its finding links there and has no button: the factory clears it once
 * the conflict is gone.
 */
const ACTION: Record<Actionable, Action> = {
  run: 'retry',
  queued_run: 'retry',
  answer_resume: 'resume',
  snapshot: 'delete_snapshot',
  revert: 'mark_revert_unknown',
}

const actionable = (subject: FindingView['subject']): subject is Actionable =>
  subject !== 'back_merge' && subject !== 'queue'

function FindingRow({ finding, onDone }: { finding: FindingView; onDone: () => void }) {
  const { t } = useCopy()
  const [message, setMessage] = useState<string>()
  const subject = finding.subject
  const todo: { label: string; confirm?: string } | undefined = actionable(subject)
    ? t.health.actions[subject]
    : undefined

  async function resolve() {
    if (!actionable(subject)) return
    if (todo?.confirm && !window.confirm(todo.confirm)) return
    try {
      await post(`/api/panel/findings/${finding.id}/resolve`, { action: ACTION[subject] })
      onDone()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Row
      lead={<RowIcon icon={TriangleAlert} tone="warning" />}
      title={t.health.kind[finding.subject]}
      meta={
        <>
          {finding.kind}
          {finding.taskId !== null ? (
            <>
              {' · '}
              <Link
                to={`/tasks/${finding.taskId}`}
                className="text-foreground underline underline-offset-2"
              >
                {finding.taskTitle ?? t.health.task(finding.taskId)}
              </Link>
            </>
          ) : null}
          {' · '}
          {t.health.since(ago(finding.firstSeenAt, Date.now(), t.time))}
        </>
      }
      detail={finding.detail}
      trail={
        subject === 'back_merge' && finding.ref ? (
          <a
            href={finding.ref}
            target="_blank"
            rel="noreferrer"
            className="text-foreground underline underline-offset-2"
          >
            {t.health.openOnGithub}
          </a>
        ) : todo ? (
          <Button size="sm" variant="secondary" onClick={() => void resolve()}>
            {todo.label}
          </Button>
        ) : undefined
      }
      below={
        message ? (
          <p role="status" className="text-sm text-destructive">
            {message}
          </p>
        ) : undefined
      }
    />
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
    <>
      <PageHeader title={h.title} />
      {report.error ? <p className="mb-3 text-sm text-destructive">{report.error}</p> : null}
      {!data ? (
        <Surface label={h.title}>
          <Quiet>{h.loading}</Quiet>
        </Surface>
      ) : (
        <div className={STACK}>
          <Surface title={h.findings} icon={Stethoscope} count={data.findings.length}>
            {data.findings.length === 0 ? (
              <Quiet>{h.nothingWrong}</Quiet>
            ) : (
              <Rows>
                {data.findings.map((f) => (
                  <FindingRow key={f.id} finding={f} onDone={report.reload} />
                ))}
              </Rows>
            )}
          </Surface>

          <Surface title={h.cost.title} icon={CircleDollarSign}>
            <Stats
              items={[
                { label: h.cost.last24, value: money(data.cost.last24HoursUsd) },
                { label: h.cost.last7, value: money(data.cost.last7DaysUsd) },
                { label: h.cost.allTime, value: money(data.cost.totalUsd) },
                {
                  label: h.cost.perTask(data.cost.tasks),
                  value: money(data.cost.avgPerTaskUsd),
                },
              ]}
            />
            {data.cost.groups.length > 0 ? (
              <div className="overflow-x-auto border-t border-border">
                <table className={TABLE.table}>
                  <thead className={TABLE.head}>
                    <tr>
                      <th className={TABLE.th}>{h.cost.agent}</th>
                      <th className={TABLE.th}>{h.cost.role}</th>
                      <th className={`${TABLE.th} text-right`}>{h.cost.runs}</th>
                      <th className={`${TABLE.th} text-right`}>{h.cost.cost}</th>
                      <th className={`${TABLE.th} text-right`}>{h.cost.averageTime}</th>
                      <th className={`${TABLE.th} text-right`}>{h.cost.failed}</th>
                      <th className={`${TABLE.th} text-right`}>{h.cost.quota}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.cost.groups.map((g) => (
                      <tr key={`${g.harness}-${g.role}`} className={TABLE.row}>
                        <td className={TABLE.td}>
                          <span className="flex items-center gap-2">
                            <AgentIcon agent={g.harness} size="sm" />
                            <span className="font-medium">{g.harness}</span>
                          </span>
                        </td>
                        <td className={TABLE.td}>{g.role}</td>
                        <td className={TABLE.number}>{g.runs}</td>
                        <td className={TABLE.number}>
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
                        <td className={TABLE.number}>{seconds(g.avgDurationMs)}</td>
                        <td className={TABLE.number}>{g.failed}</td>
                        <td className={TABLE.number}>{g.quota}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="border-t border-border">
                <Quiet>{h.cost.none}</Quiet>
              </div>
            )}
          </Surface>

          <MetricsSection />
        </div>
      )}
    </>
  )
}

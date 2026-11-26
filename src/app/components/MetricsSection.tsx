import { Activity, TriangleAlert } from 'lucide-react'

import type { MetricBand, MetricRow, MetricsReport } from '../../shared/panel'
import { useCopy } from '../lib/copy'
import { metricValue } from '../lib/format'
import { useResource } from '../lib/live'

import { Quiet, READABLE, Row, RowIcon, Rows, Surface, TABLE } from './ui/Surface'

const BAND: Record<MetricBand, string> = {
  no_baseline: 'text-muted-foreground',
  in_band: 'text-foreground',
  log: 'text-foreground',
  show: 'font-medium text-foreground',
  act: 'text-destructive',
}

function baseline(row: MetricRow): string {
  if (row.mean === null || row.sd === null) return '—'
  return `${metricValue(row.mean, row.unit)} ± ${metricValue(row.sd, row.unit)}`
}

/** The factory's own indicators, each latest day against its control band, and the signals worth a look. */
export function MetricsSection() {
  const { t } = useCopy()
  const where = (repository: string) =>
    repository === '*' ? t.metrics.allRepositories : repository
  const metrics = useResource<MetricsReport>('/api/panel/metrics', {
    stream: false,
    everyMs: 60_000,
  })
  const data = metrics.data
  return (
    <Surface title={t.metrics.heading} icon={Activity}>
      {metrics.error ? <p className="px-4 py-3 text-sm text-destructive">{metrics.error}</p> : null}
      {!data ? null : data.rows.length === 0 ? (
        <Quiet>{t.metrics.empty}</Quiet>
      ) : (
        <div className="overflow-x-auto">
          <table className={TABLE.table}>
            <thead className={TABLE.head}>
              <tr>
                <th className={TABLE.th}>{t.metrics.indicator}</th>
                <th className={TABLE.th}>{t.metrics.repository}</th>
                <th className={TABLE.th}>{t.metrics.day}</th>
                <th className={`${TABLE.th} text-right`}>{t.metrics.value}</th>
                <th className={`${TABLE.th} text-right`}>{t.metrics.baseline}</th>
                <th className={TABLE.th}>{t.metrics.band}</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={`${r.metric}-${r.repository}`} className={TABLE.row}>
                  <td className={`${TABLE.td} font-medium`}>{r.label}</td>
                  <td className={TABLE.td}>{where(r.repository)}</td>
                  <td className={`${TABLE.td} font-mono text-xs`}>{r.day}</td>
                  <td className={TABLE.number}>
                    {metricValue(r.value, r.unit)}
                    <span className="text-xs text-muted-foreground"> ({r.samples})</span>
                  </td>
                  <td className={TABLE.number}>{baseline(r)}</td>
                  <td className={`${TABLE.td} ${BAND[r.band]}`}>{t.metrics.bands[r.band]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data?.conflictSessions ? (
        <p
          className={`border-t border-border px-4 py-3 text-sm ${READABLE}`}
          data-metric="conflict_sessions"
        >
          {t.metrics.conflictSessions(
            data.conflictSessions.last14Days,
            data.conflictSessions.previous14Days,
          )}
        </p>
      ) : null}
      {data && data.signals.length > 0 ? (
        <div className="border-t border-border">
          <Rows>
            {data.signals.map((s) => (
              <Row
                key={`${s.metric}-${s.repository}-${s.day}-${s.rule}`}
                lead={<RowIcon icon={TriangleAlert} tone={s.error ? 'destructive' : 'warning'} />}
                trail={
                  s.issueUrl ? (
                    <a href={s.issueUrl} className="text-foreground underline underline-offset-2">
                      {t.metrics.issue}
                    </a>
                  ) : undefined
                }
              >
                <span className="block text-sm">
                  <span className="font-medium">{s.label}</span>
                  {t.metrics.brokeIn}
                  {where(s.repository)}
                  {t.metrics.broke}
                  <code>{s.rule}</code>
                  {t.metrics.on}
                  {s.day}
                  {s.error ? (
                    <span className="text-destructive">{t.metrics.notOpened(s.error)}</span>
                  ) : null}
                </span>
              </Row>
            ))}
          </Rows>
        </div>
      ) : null}
    </Surface>
  )
}

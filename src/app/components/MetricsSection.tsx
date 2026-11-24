import type { MetricBand, MetricRow, MetricsReport } from '../../shared/panel'
import { useCopy } from '../lib/copy'
import { metricValue } from '../lib/format'
import { useResource } from '../lib/live'

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
    <section aria-label={t.metrics.heading}>
      <h2 className="mb-2 text-sm font-semibold">{t.metrics.heading}</h2>
      {metrics.error ? <p className="text-sm text-destructive">{metrics.error}</p> : null}
      {!data ? null : data.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.metrics.empty}</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="py-1 pr-3">{t.metrics.indicator}</th>
              <th className="py-1 pr-3">{t.metrics.repository}</th>
              <th className="py-1 pr-3">{t.metrics.day}</th>
              <th className="py-1 pr-3">{t.metrics.value}</th>
              <th className="py-1 pr-3">{t.metrics.baseline}</th>
              <th className="py-1 pr-3">{t.metrics.band}</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={`${r.metric}-${r.repository}`} className="border-t border-border">
                <td className="py-1 pr-3 font-medium">{r.label}</td>
                <td className="py-1 pr-3">{where(r.repository)}</td>
                <td className="py-1 pr-3">{r.day}</td>
                <td className="py-1 pr-3">
                  {metricValue(r.value, r.unit)}
                  <span className="text-xs text-muted-foreground"> ({r.samples})</span>
                </td>
                <td className="py-1 pr-3">{baseline(r)}</td>
                <td className={`py-1 pr-3 ${BAND[r.band]}`}>{t.metrics.bands[r.band]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data?.conflictSessions ? (
        <p className="mt-3 text-sm" data-metric="conflict_sessions">
          {t.metrics.conflictSessions(
            data.conflictSessions.last14Days,
            data.conflictSessions.previous14Days,
          )}
        </p>
      ) : null}
      {data && data.signals.length > 0 ? (
        <ul className="mt-3 space-y-1 text-sm">
          {data.signals.map((s) => (
            <li key={`${s.metric}-${s.repository}-${s.day}-${s.rule}`}>
              <span className="font-medium">{s.label}</span>
              {t.metrics.brokeIn}
              {where(s.repository)}
              {t.metrics.broke}
              <code>{s.rule}</code>
              {t.metrics.on}
              {s.day}
              {s.issueUrl ? (
                <>
                  {' '}
                  —{' '}
                  <a href={s.issueUrl} className="underline underline-offset-2">
                    {t.metrics.issue}
                  </a>
                </>
              ) : null}
              {s.error ? (
                <span className="text-destructive">{t.metrics.notOpened(s.error)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

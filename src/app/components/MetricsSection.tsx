import type { AgentComparison, MetricBand, MetricRow, MetricsReport } from '../../shared/panel'
import { metricValue } from '../lib/format'
import { useCopy } from '../lib/copy'
import { useResource } from '../lib/live'

const BAND: Record<MetricBand, { label: string; className: string }> = {
  no_baseline: { label: 'no baseline yet', className: 'text-muted-foreground' },
  in_band: { label: 'in band', className: 'text-foreground' },
  log: { label: 'drifting', className: 'text-foreground' },
  show: { label: 'out of band', className: 'font-medium text-foreground' },
  act: { label: 'issue opened', className: 'text-destructive' },
}

const where = (repository: string) => (repository === '*' ? 'All repositories' : repository)

function baseline(row: MetricRow): string {
  if (row.mean === null || row.sd === null) return '—'
  return `${metricValue(row.mean, row.unit)} ± ${metricValue(row.sd, row.unit)}`
}

const who = (agent: string, model: string | null) => (model ? `${agent} · ${model}` : agent)
const percent = (share: number) => `${Math.round(share * 100)}%`

/** What the reviewers did, one row for each agent and model that reviewed, so a change of reviewer can be compared. */
function ByReviewer({ data }: { data: AgentComparison }) {
  const { t } = useCopy()
  const w = t.byReviewer
  if (
    data.approval.length === 0 &&
    data.reviewerRework.length === 0 &&
    data.reviewerCost.length === 0
  )
    return null
  const rows = new Map<string, { label: string; cells: Record<string, string> }>()
  const put = (agent: string, model: string | null, cell: string, value: string) => {
    const key = JSON.stringify([agent, model])
    const row = rows.get(key) ?? { label: who(agent, model), cells: {} }
    row.cells[cell] = value
    rows.set(key, row)
  }
  for (const a of data.approval)
    put(a.reviewer, a.model, 'approval', `${percent(a.share)} (${a.approved}/${a.reviews})`)
  for (const r of data.reviewerRework)
    put(r.reviewer, r.model, 'rework', w.reworkValue(r.reworkRounds, r.reviews))
  for (const c of data.reviewerCost)
    put(
      c.agent,
      c.model,
      'cost',
      c.perDelivery === null
        ? w.unknownCost(c.deliveredRuns)
        : w.knownCost(c.perDelivery.toFixed(2), c.reportedRuns, c.deliveredRuns),
    )
  return (
    <div className="mt-4">
      <h3 className="mb-2 text-sm font-semibold">{w.title}</h3>
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className="py-1 pr-3">{w.reviewer}</th>
            <th className="py-1 pr-3">{w.approval}</th>
            <th className="py-1 pr-3">{w.rework}</th>
            <th className="py-1 pr-3">{w.cost}</th>
          </tr>
        </thead>
        <tbody>
          {[...rows.entries()].map(([key, row]) => (
            <tr key={key} className="border-t border-border">
              <td className="py-1 pr-3 font-medium">{row.label}</td>
              <td className="py-1 pr-3">{row.cells.approval ?? '—'}</td>
              <td className="py-1 pr-3">{row.cells.rework ?? '—'}</td>
              <td className="py-1 pr-3">{row.cells.cost ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The factory's own indicators, each latest day against its control band, and the signals worth a look. */
export function MetricsSection() {
  const metrics = useResource<MetricsReport>('/api/panel/metrics', {
    stream: false,
    everyMs: 60_000,
  })
  const data = metrics.data
  return (
    <section aria-label="Metrics">
      <h2 className="mb-2 text-sm font-semibold">Metrics</h2>
      {metrics.error ? <p className="text-sm text-destructive">{metrics.error}</p> : null}
      {!data ? null : data.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Not enough finished work to measure yet.</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="py-1 pr-3">Indicator</th>
              <th className="py-1 pr-3">Repository</th>
              <th className="py-1 pr-3">Day</th>
              <th className="py-1 pr-3">Value</th>
              <th className="py-1 pr-3">Baseline</th>
              <th className="py-1 pr-3">Band</th>
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
                <td className={`py-1 pr-3 ${BAND[r.band].className}`}>{BAND[r.band].label}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data ? <ByReviewer data={data.byAgent} /> : null}
      {data && data.signals.length > 0 ? (
        <ul className="mt-3 space-y-1 text-sm">
          {data.signals.map((s) => (
            <li key={`${s.metric}-${s.repository}-${s.day}-${s.rule}`}>
              <span className="font-medium">{s.label}</span> in {where(s.repository)} broke{' '}
              <code>{s.rule}</code> on {s.day}
              {s.issueUrl ? (
                <>
                  {' '}
                  —{' '}
                  <a href={s.issueUrl} className="underline underline-offset-2">
                    issue
                  </a>
                </>
              ) : null}
              {s.error ? (
                <span className="text-destructive"> (issue not opened: {s.error})</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

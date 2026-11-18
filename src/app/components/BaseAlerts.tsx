import type { TaskCard } from '../../shared/panel'
import { baseAlerts } from '../lib/base-alerts'
import { useCopy } from '../lib/copy'
import { duration } from '../lib/format'

/**
 * The red integration branches that hold delivered work, at the top of the board, so a red base is seen the
 * moment it starts to cost and not hours later on a card.
 */
export function BaseAlerts({ tasks, now = new Date() }: { tasks: TaskCard[]; now?: Date }) {
  const { t } = useCopy()
  const alerts = baseAlerts(tasks, now)
  if (alerts.length === 0) return null
  return (
    <div
      role="alert"
      aria-label={t.baseAlert.region}
      className="mb-4 rounded-md border border-destructive bg-background p-3 ring-1 ring-destructive/40"
    >
      <ul className="space-y-1 text-sm font-medium text-destructive">
        {alerts.map((a) => (
          <li key={`${a.repository}:${a.branch}`} data-base-alert={a.repository}>
            {t.baseAlert.line(
              a.repository,
              a.branch,
              a.checks.join(', '),
              a.held,
              duration(a.minutes),
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

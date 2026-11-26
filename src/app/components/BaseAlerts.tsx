import { Siren } from 'lucide-react'

import type { TaskCard } from '../../shared/panel'
import { baseAlerts } from '../lib/base-alerts'
import { useCopy } from '../lib/copy'
import { duration } from '../lib/format'

import { Row, RowIcon, Rows } from './ui/Surface'

/** An alert is a sheet like any block of the page, with a red border in place of the usual one. */
export const ALERT_SHEET =
  'mb-4 w-full overflow-hidden rounded-xl border border-destructive bg-card'

/**
 * The red integration branches that hold delivered work, at the top of the board, so a red base is seen the
 * moment it starts to cost and not hours later on a card.
 */
export function BaseAlerts({ tasks, now = new Date() }: { tasks: TaskCard[]; now?: Date }) {
  const { t } = useCopy()
  const alerts = baseAlerts(tasks, now)
  if (alerts.length === 0) return null
  return (
    <div role="alert" aria-label={t.baseAlert.region} className={ALERT_SHEET}>
      <Rows>
        {alerts.map((a) => (
          <Row
            key={`${a.repository}:${a.branch}`}
            lead={<RowIcon icon={Siren} tone="destructive" />}
          >
            <span
              data-base-alert={a.repository}
              className="block text-sm font-medium text-destructive"
            >
              {t.baseAlert.line(
                a.repository,
                a.branch,
                a.checks.join(', '),
                a.held,
                duration(a.minutes),
              )}
            </span>
          </Row>
        ))}
      </Rows>
    </div>
  )
}

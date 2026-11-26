import { OctagonX } from 'lucide-react'

import type { StoppedLine } from '../../shared/panel'
import { useCopy } from '../lib/copy'
import { duration } from '../lib/format'

import { ALERT_SHEET } from './BaseAlerts'
import { Row, RowIcon, Rows } from './ui/Surface'

/**
 * The repositories whose line is stopped, above everything on the board: while one is, the factory works only
 * on its fix there, so the owner sees why nothing else moves.
 */
export function LineAlerts({ lines, now = new Date() }: { lines: StoppedLine[]; now?: Date }) {
  const { t } = useCopy()
  if (lines.length === 0) return null
  return (
    <div role="alert" aria-label={t.lineAlert.region} className={ALERT_SHEET}>
      <Rows>
        {lines.map((l) => (
          <Row key={l.repository} lead={<RowIcon icon={OctagonX} tone="destructive" />}>
            <span
              data-line-alert={l.repository}
              className="block text-sm font-medium text-destructive"
            >
              {(l.scope === 'fix_first' ? t.lineAlert.lineFixFirst : t.lineAlert.line)(
                l.repository,
                l.surface,
                duration((now.getTime() - Date.parse(l.since)) / 60_000),
              )}{' '}
              <a href={l.issueUrl} target="_blank" rel="noreferrer" className="underline">
                {l.status === 'escalated'
                  ? t.lineAlert.person(l.issueNumber)
                  : t.lineAlert.fix(l.issueNumber, l.attempts)}
              </a>
            </span>
          </Row>
        ))}
      </Rows>
    </div>
  )
}

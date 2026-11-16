import { useState } from 'react'
import { Link } from 'react-router'

import type { CoordinatorActionView } from '../../shared/panel'
import { CoordinatorActions } from '../components/CoordinatorActions'
import { useCopy } from '../lib/copy'
import { useResource } from '../lib/live'

const OUTCOMES = ['applied', 'trial', 'refused', 'failed', 'escalated']

/** What the coordinator decided across tasks, newest first, filtered by what became of it. */
export default function CoordinatorPage() {
  const { t } = useCopy()
  const [outcome, setOutcome] = useState('')
  const list = useResource<{ actions: CoordinatorActionView[] }>(
    `/api/panel/coordinator${outcome ? `?outcome=${outcome}` : ''}`,
  )
  return (
    <>
      <Link to="/inbox" className="text-sm text-muted-foreground hover:text-foreground">
        {t.coordinator.back}
      </Link>
      <h1 className="mb-1 mt-1 text-xl font-semibold">{t.coordinator.heading}</h1>
      <p className="mb-4 text-sm text-muted-foreground">{t.coordinator.intro}</p>
      <label className="mb-4 flex items-center gap-2 text-sm">
        {t.coordinator.filter}
        <select
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          className="rounded-md border border-border bg-background px-2 py-1"
        >
          <option value="">{t.coordinator.all}</option>
          {OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {t.coordinator.outcomes[o]}
            </option>
          ))}
        </select>
      </label>
      {list.error ? <p className="text-sm text-destructive">{list.error}</p> : null}
      {list.data ? (
        list.data.actions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.coordinator.empty}</p>
        ) : (
          <CoordinatorActions actions={list.data.actions} withTask />
        )
      ) : (
        <p className="text-sm text-muted-foreground">{t.layout.loading}</p>
      )}
    </>
  )
}

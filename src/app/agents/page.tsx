import { Alert, Input } from '@usetheo/ui'
import { Search } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { Metadata } from 'theokit/client'

import type { AgentsView } from '../../shared/panel'
import { AgentDetail } from '../components/agents/AgentDetail'
import { AgentList } from '../components/agents/AgentList'
import { PageHeader, Quiet, STACK, Surface } from '../components/ui/Surface'
import { filterAgents } from '../lib/agents'
import { useCopy } from '../lib/copy'
import { useResource } from '../lib/live'

/** Who works in the factory, what each is told, and what each may do. Read from the code that runs them. */
export default function AgentsPage() {
  const { t } = useCopy()
  const { data, error, reload } = useResource<AgentsView>('/api/panel/agents', {
    stream: false,
    everyMs: 60_000,
  })
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState('')

  const shown = data ? filterAgents(data.agents, query) : []
  const wanted = params.get('agent')
  const selected = shown.find((a) => a.id === wanted) ?? shown[0]

  return (
    <>
      <Metadata title={t.agents.metaTitle} description={t.agents.metaDescription} />
      <PageHeader
        title={t.agents.heading}
        lede={t.agents.intro}
        actions={
          <label className="relative block w-72 max-w-full">
            <span className="sr-only">{t.agents.searchLabel}</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label={t.agents.searchLabel}
              placeholder={t.agents.searchLabel}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9"
            />
          </label>
        }
      />
      <div className={STACK}>
        {error ? (
          <Alert intent="destructive" title={t.agents.loadError} description={error} />
        ) : null}
        {!data && !error ? (
          <Surface label={t.agents.heading}>
            <Quiet>{t.agents.loading}</Quiet>
          </Surface>
        ) : null}

        {data ? (
          shown.length === 0 ? (
            <Surface label={t.agents.heading}>
              <Quiet role="status">{t.agents.none(query)}</Quiet>
            </Surface>
          ) : (
            // The list stays beside what it chooses, so these two are the columns of one page.
            <div className="grid items-start gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
              <div className="lg:sticky lg:top-2">
                <AgentList
                  agents={shown}
                  selected={selected?.id}
                  onSelect={(id) => setParams({ agent: id }, { replace: true })}
                />
              </div>
              {selected ? (
                <AgentDetail
                  key={selected.id}
                  agent={selected}
                  shared={data.shared}
                  settings={data.settings}
                  query={query}
                  onSettingsSaved={reload}
                />
              ) : null}
            </div>
          )
        ) : null}
      </div>
    </>
  )
}

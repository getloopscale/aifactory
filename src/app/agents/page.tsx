import { Alert, Input } from '@usetheo/ui'
import { Search } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { Metadata } from 'theokit/client'

import type { AgentsView } from '../../shared/panel'
import { AgentDetail } from '../components/agents/AgentDetail'
import { AgentList } from '../components/agents/AgentList'
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
    <div className="space-y-5">
      <Metadata title={t.agents.metaTitle} description={t.agents.metaDescription} />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t.agents.heading}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t.agents.intro}</p>
        </div>
        <label className="relative block w-full max-w-sm">
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
      </div>

      {error ? <Alert intent="destructive" title={t.agents.loadError} description={error} /> : null}
      {!data && !error ? <p className="text-sm text-muted-foreground">{t.agents.loading}</p> : null}

      {data ? (
        shown.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t.agents.none(query)}
          </p>
        ) : (
          <div className="grid gap-8 lg:grid-cols-[260px_minmax(0,1fr)]">
            <div className="lg:sticky lg:top-2 lg:self-start">
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
  )
}

import { Input } from '@getloopscale/ui'
import { Search } from 'lucide-react'

import { ORDERS, WINDOWS, type BoardFilter, type Order } from '../lib/board-lanes'
import { useCopy } from '../lib/copy'

const SELECT =
  'h-8 max-w-48 rounded-md border border-border bg-card px-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring'

/**
 * What narrows the board and the list: a search over what a card says, how far back the ended tasks go, one
 * repository, and the order. The tasks still open are never cut by the time.
 */
export function BoardBar({
  filter,
  repositories,
  onChange,
}: {
  filter: BoardFilter
  repositories: string[]
  onChange: (next: BoardFilter) => void
}) {
  const { t } = useCopy()
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <div className="relative min-w-40 max-w-xs flex-1">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          aria-label={t.board.search}
          placeholder={t.board.search}
          value={filter.text}
          onChange={(event) => onChange({ ...filter, text: event.target.value })}
          className="h-8 pl-8"
        />
      </div>
      <div
        role="group"
        aria-label={t.board.windowGroup}
        title={t.board.windowGroup}
        className="flex overflow-hidden rounded-md border border-border"
      >
        {WINDOWS.map((days) => (
          <button
            key={days ?? 'all'}
            type="button"
            aria-pressed={filter.window === days}
            onClick={() => onChange({ ...filter, window: days })}
            className={`h-8 px-2.5 text-sm tabular-nums ${filter.window === days ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {t.board.window[days ?? 'all']}
          </button>
        ))}
      </div>
      {repositories.length > 1 ? (
        <select
          aria-label={t.board.repositoryFilter}
          value={filter.repository ?? ''}
          onChange={(event) => onChange({ ...filter, repository: event.target.value || null })}
          className={SELECT}
        >
          <option value="">{t.board.allRepositories}</option>
          {repositories.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      ) : null}
      <select
        aria-label={t.board.orderLabel}
        value={filter.order}
        onChange={(event) => onChange({ ...filter, order: event.target.value as Order })}
        className={`${SELECT} ml-auto`}
      >
        {ORDERS.map((order) => (
          <option key={order} value={order}>
            {t.board.order[order]}
          </option>
        ))}
      </select>
    </div>
  )
}

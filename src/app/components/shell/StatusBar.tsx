import { Link } from 'react-router'

import type { PulseReport } from '../../../shared/panel'
import { useCopy } from '../../lib/copy'

const cell =
  'flex h-full items-center gap-1.5 px-2.5 transition-colors hover:bg-muted/60 hover:text-foreground'

function Dot({ tone }: { tone: string }) {
  return <span aria-hidden className={`size-1.5 rounded-full ${tone}`} />
}

/**
 * The strip under every page: what the factory does this minute and what waits for the owner, each a way to
 * the page that says more. It repeats nothing the page shows; it is what stays in sight on any page.
 */
export function StatusBar({
  pulse,
  waiting,
  wrong,
}: {
  pulse?: PulseReport
  waiting: number
  wrong: number
}) {
  const { t } = useCopy()
  return (
    <footer
      aria-label={t.statusBar.label}
      className="flex h-7 shrink-0 items-stretch border-t border-border bg-card font-mono text-[11px] tabular-nums text-muted-foreground"
    >
      {pulse ? (
        <Link to="/floor" className={cell}>
          <Dot tone={pulse.working > 0 ? 'bg-success' : 'bg-muted-foreground/50'} />
          {t.topBar.working(pulse.working)}
          <span aria-hidden>·</span>
          {t.topBar.queued(pulse.queued)}
        </Link>
      ) : null}
      <Link to="/inbox" className={cell}>
        <Dot tone={waiting > 0 ? 'bg-info' : 'bg-muted-foreground/50'} />
        {t.statusBar.waiting(waiting)}
      </Link>
      <Link to="/health" className={`${cell} ml-auto`}>
        <Dot tone={wrong > 0 ? 'bg-warning' : 'bg-success'} />
        {wrong > 0 ? t.statusBar.wrong(wrong) : t.statusBar.healthy}
      </Link>
    </footer>
  )
}

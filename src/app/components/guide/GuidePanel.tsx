import { Sparkles, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation } from 'react-router'

import type { GuideId } from '../../../shared/guides'
import { useCopy } from '../../lib/copy'
import { guideIdFor, guideIn } from '../../lib/guides'
import { useGuideState } from '../../lib/guide-state'
import { useEscape } from '../../lib/keys'
import { useWidth } from '../../lib/media'

import { GuideThread } from './GuideThread'

/**
 * The specialist of the page, beside it. It opens from the bar over the page, takes the width of a column
 * on a wide screen and covers the page on a narrow one, and the page stays where it is. Each guide is
 * started the first time it is opened and then kept, so going to another page and back loses nothing.
 */
export function GuidePanel() {
  const { pathname, search } = useLocation()
  const { t } = useCopy()
  const { open, setOpen, markSeen } = useGuideState()
  const guideId = guideIdFor(pathname)
  const guide = guideId ? guideIn(guideId, t) : undefined
  const [started, setStarted] = useState<GuideId[]>([])
  const shown = open && guide !== undefined
  // Beside the page when there is room, a sheet over it when there is not; the shell decides.
  const wide = useWidth() === 'expanded'
  const compact = useWidth() === 'compact'

  useEffect(() => {
    if (!shown || !guideId) return
    markSeen(guideId)
    setStarted((current) => (current.includes(guideId) ? current : [...current, guideId]))
  }, [shown, guideId, markSeen])

  useEscape(() => {
    if (shown) setOpen(false)
  })

  if (!shown || !guide) return null
  return (
    <aside
      aria-label={guide.name}
      data-sheet={wide ? undefined : ''}
      className={`flex flex-col border-l border-border bg-card ${wide ? 'relative w-[400px] shrink-0' : `fixed inset-y-0 right-0 z-40 shadow-2xl ${compact ? 'w-full' : 'w-[min(420px,100vw)]'}`}`}
    >
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted">
          <Sparkles className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-medium">{guide.name}</h2>
          <p className="truncate text-xs text-foreground/55">{t.guide.subtitle}</p>
        </div>
        <button
          type="button"
          aria-label={t.guide.close}
          onClick={() => setOpen(false)}
          className="rounded-lg p-2 text-foreground/80 hover:bg-muted/60"
        >
          <X className="size-[18px]" />
        </button>
      </header>
      {started.map((id) => (
        <GuideThread
          key={id}
          guide={guideIn(id, t)}
          active={id === guide.id}
          pathname={pathname}
          search={search}
        />
      ))}
    </aside>
  )
}

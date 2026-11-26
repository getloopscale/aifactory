import { useState } from 'react'

import { Button } from '@usetheo/ui'
import {
  CircleCheck,
  CircleHelp,
  Eye,
  type LucideIcon,
  ShieldAlert,
  Siren,
  Undo2,
} from 'lucide-react'

import type { WatchView } from '../../shared/panel'
import { post } from '../lib/api'
import { useCopy } from '../lib/copy'
import { ago, shortSha } from '../lib/format'

import { Row, RowIcon, Rows, Surface, type Tone } from './ui/Surface'

const STATUS_ICON: Record<WatchView['status'], LucideIcon> = {
  watching: Eye,
  reverting: Undo2,
  green: CircleCheck,
  red: Siren,
  silent: CircleHelp,
}

/** A red branch stays red until the owner says it was dealt with; a watch still running is the factory's. */
function toneOf(watch: WatchView): Tone {
  if (watch.status === 'red') return watch.acknowledged ? 'neutral' : 'destructive'
  if (watch.status === 'green') return 'success'
  return watch.status === 'silent' ? 'neutral' : 'info'
}

/**
 * What happened to the default branch after a release. A red one comes with the revert pull request
 * the factory opened, which only a person merges, and a way to say it was dealt with.
 */
export function WatchPanel({ watches, onDone }: { watches: WatchView[]; onDone: () => void }) {
  const { t } = useCopy()
  const [message, setMessage] = useState<string>()
  if (watches.length === 0) return null

  async function handled(id: number) {
    try {
      await post(`/api/panel/watches/${id}/handled`)
      onDone()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Surface title={t.watch.title} label={t.watch.label} icon={ShieldAlert} count={watches.length}>
      <Rows>
        {watches.map((w) => (
          <Row
            key={w.id}
            lead={<RowIcon icon={STATUS_ICON[w.status]} tone={toneOf(w)} />}
            title={t.watch.status[w.status]}
            meta={
              <>
                {w.tag ?? t.watch.release} · {t.watch.merge} {shortSha(w.sha)} ·{' '}
                {ago(w.endedAt ?? w.startedAt, Date.now(), t.time)}
              </>
            }
            detail={w.detail ?? undefined}
            trail={
              w.status === 'red' ? (
                <>
                  {w.revertUrl ? (
                    <a
                      href={w.revertUrl}
                      className="text-foreground underline underline-offset-2"
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t.watch.revert}
                    </a>
                  ) : null}
                  {w.acknowledged ? (
                    <span className="text-muted-foreground">{t.watch.dealtWith}</span>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => void handled(w.id)}>
                      {t.watch.handled}
                    </Button>
                  )}
                </>
              ) : undefined
            }
            below={
              w.status === 'red' && !w.revertUrl ? (
                <span className="text-sm text-destructive">{t.watch.noRevert}</span>
              ) : undefined
            }
          />
        ))}
      </Rows>
      {message ? (
        <p role="status" className="border-t border-border px-4 py-3 text-sm text-foreground">
          {message}
        </p>
      ) : null}
    </Surface>
  )
}

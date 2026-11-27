import { DropdownMenu } from '@getloopscale/ui'
import { ArrowUp, ListChecks, Plus, Square, TriangleAlert, FilePlus2 } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import { useCopy } from '../../lib/copy'

type Start = { icon: typeof FilePlus2; label: string; text: string }

/** One line of the text and the padding above and below it, in pixels. */
const LINE = 24
const ONE_LINE = LINE + 12

/** How tall the text may grow before it scrolls: eight lines, or two fifths of a taller window. */
export const tallest = (windowHeight: number) => Math.max(8 * LINE, Math.round(windowHeight * 0.4))

/**
 * The box a message is written in. A short message is one row: the "+" at the left, the model and the send
 * button at the right. A message of more than one line takes the whole width, with those under it, so a long
 * text is not squeezed between the buttons. Enter sends and Shift+Enter breaks the line.
 */
export function PillComposer({
  starts: given,
  value,
  onValueChange,
  onSubmit,
  running,
  onStop,
  trailing,
  placeholder,
}: {
  /** What the "+" offers. None hides it. */
  starts?: Start[]
  value: string
  onValueChange: (value: string) => void
  onSubmit: (value: string) => void
  running: boolean
  onStop: () => void
  trailing?: ReactNode
  placeholder?: string
}) {
  const { t } = useCopy()
  /** What the "+" offers: a way to start a message that would otherwise take a sentence to word. */
  const starts = given ?? [
    { icon: FilePlus2, ...t.composer.startIssue },
    { icon: ListChecks, ...t.composer.startPlan },
    { icon: TriangleAlert, ...t.composer.startStuck },
  ]
  const box = useRef<HTMLTextAreaElement>(null)
  const canSend = value.trim() !== '' && !running
  // Whether the text has its own row. It keeps it until the box is empty: going back as soon as the text fits one
  // line again would change the width the text wraps at, and the box would flip between the two.
  const [tall, setTall] = useState(false)

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    const needed = el.scrollHeight
    el.style.height = `${Math.min(needed, tallest(window.innerHeight))}px`
    if (value === '') setTall(false)
    else if (needed > ONE_LINE || value.includes('\n')) setTall(true)
  }, [value, tall])

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (canSend) onSubmit(value)
      }}
      data-tall={tall || undefined}
      className={`grid grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-x-1 border border-border bg-card px-2.5 py-2 focus-within:border-foreground/30 ${tall ? 'gap-y-1 rounded-3xl' : 'rounded-[28px]'}`}
    >
      {starts.length > 0 ? (
        <DropdownMenu>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label={t.composer.moreActions}
              className={`mb-0.5 shrink-0 rounded-full p-2 text-foreground/80 hover:bg-muted/60 ${tall ? 'col-start-1 row-start-2' : ''}`}
            >
              <Plus className="size-5" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="start" side="top" sideOffset={18} className="min-w-56">
            {starts.map(({ icon: Icon, label, text }) => (
              <DropdownMenu.Item
                key={label}
                onSelect={() => {
                  onValueChange(text)
                  requestAnimationFrame(() => box.current?.focus())
                }}
              >
                <Icon className="mr-2 size-4" />
                {label}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu>
      ) : null}
      <textarea
        ref={box}
        rows={1}
        value={value}
        aria-label={t.composer.message}
        placeholder={placeholder ?? t.composer.placeholder}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            if (canSend) onSubmit(value)
          }
        }}
        className={`min-h-6 w-full resize-none self-center bg-transparent py-1.5 text-[15px] leading-6 text-foreground outline-none [scrollbar-width:thin] placeholder:text-foreground/45 ${tall ? 'col-span-full row-start-1 px-3 pt-2' : 'col-start-2 px-2'}`}
      />
      <div
        className={`col-start-3 mb-0.5 flex shrink-0 items-center gap-1 ${tall ? 'row-start-2' : ''}`}
      >
        {trailing}
        {running ? (
          <button
            type="button"
            aria-label={t.composer.stop}
            onClick={onStop}
            className="grid size-9 place-items-center rounded-full bg-foreground text-background"
          >
            <Square className="size-3.5 fill-current" />
          </button>
        ) : (
          <button
            type="submit"
            aria-label={t.composer.send}
            disabled={!canSend}
            className="grid size-9 place-items-center rounded-full bg-foreground text-background transition-opacity disabled:opacity-25"
          >
            <ArrowUp className="size-[18px]" />
          </button>
        )}
      </div>
    </form>
  )
}

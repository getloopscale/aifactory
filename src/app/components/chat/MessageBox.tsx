import { Button, DropdownMenu } from '@getloopscale/ui'
import { ArrowUp, ListChecks, Plus, Square, TriangleAlert, FilePlus2 } from 'lucide-react'
import { useLayoutEffect, useRef, type ReactNode } from 'react'

import { useCopy } from '../../lib/copy'
import { enterSends } from '../../lib/enter-sends'

type Start = { icon: typeof FilePlus2; label: string; text: string }

/** One line of the text, in pixels. */
const LINE = 24

/** How tall the text may grow before it scrolls: eight lines, or two fifths of a taller window. */
export const tallest = (windowHeight: number) => Math.max(8 * LINE, Math.round(windowHeight * 0.4))

/** A small control of the row under the text: the height and the corners every one of them has. */
export const TOOL =
  'flex h-7 items-center gap-1 rounded-md text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'

/**
 * The box a message to an assistant is written in, in the shape of the box a task's agent is written to
 * (`Conversation.tsx`): the text has the whole width, and under it a row holds the "+" at the left, the model and
 * the send button at the right. Enter sends and Shift+Enter breaks the line.
 */
export function MessageBox({
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

  // The text is one line until it needs more, and scrolls past the tallest it may be.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, tallest(window.innerHeight))}px`
  }, [value])

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (canSend) onSubmit(value)
      }}
      className="rounded-xl border border-border bg-card focus-within:border-foreground/40"
    >
      <textarea
        ref={box}
        rows={1}
        value={value}
        aria-label={t.composer.message}
        placeholder={placeholder ?? t.composer.placeholder}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={enterSends(() => {
          if (canSend) onSubmit(value)
        })}
        className="block min-h-6 w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-sm leading-6 text-foreground outline-none [scrollbar-width:thin] placeholder:text-muted-foreground"
      />
      <div className="flex items-center gap-1 px-2 pb-2">
        {starts.length > 0 ? (
          <DropdownMenu>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                aria-label={t.composer.moreActions}
                title={t.composer.moreActions}
                className={`${TOOL} w-7 justify-center`}
              >
                <Plus className="size-4" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="start" side="top" sideOffset={6} className="min-w-56">
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
        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          {trailing}
          {running ? (
            <Button
              type="button"
              size="sm"
              aria-label={t.composer.stop}
              title={t.composer.stop}
              onClick={onStop}
              className="size-8 shrink-0 rounded-full p-0"
            >
              <Square aria-hidden className="size-3 fill-current" />
            </Button>
          ) : (
            <Button
              type="submit"
              size="sm"
              aria-label={t.composer.send}
              title={t.composer.send}
              disabled={!canSend}
              className="size-8 shrink-0 rounded-full p-0"
            >
              <ArrowUp aria-hidden className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </form>
  )
}

import { DropdownMenu } from '@getloopscale/ui'
import { ArrowUp, ListChecks, Plus, Square, TriangleAlert, FilePlus2 } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'

import { useCopy } from '../../lib/copy'

type Start = { icon: typeof FilePlus2; label: string; text: string }

/**
 * The box a message is written in: one row that grows with the text, the "+" at the left, the model and
 * the send button at the right. Enter sends and Shift+Enter breaks the line.
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

  // The box is one line until the text needs more, and stops growing at eight.
  useEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 8 * 24)}px`
  }, [value])

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (canSend) onSubmit(value)
      }}
      className="flex items-end gap-1 rounded-[28px] border border-border bg-card px-2.5 py-2"
    >
      {starts.length > 0 ? (
        <DropdownMenu>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label={t.composer.moreActions}
              className="mb-0.5 shrink-0 rounded-full p-2 text-foreground/80 hover:bg-muted/60"
            >
              <Plus className="size-5" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="start" side="top" className="min-w-56">
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
        className="max-h-48 min-h-6 flex-1 resize-none self-center bg-transparent px-2 py-1.5 text-[15px] leading-6 text-foreground outline-none placeholder:text-foreground/45"
      />
      <div className="mb-0.5 flex shrink-0 items-center gap-1">
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

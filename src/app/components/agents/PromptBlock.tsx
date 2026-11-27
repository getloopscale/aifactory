import { Button } from '@getloopscale/ui'
import { Check, Copy } from 'lucide-react'
import { useState } from 'react'

import type { AgentPrompt } from '../../../shared/panel'
import { markCount, pieces } from '../../lib/agents'
import { useCopy } from '../../lib/copy'
import { SurfaceHeading } from '../ui/Surface'

const STYLE = {
  plain: '',
  mark: 'rounded bg-info/15 px-0.5 text-foreground',
  hit: 'rounded bg-warning/30 text-foreground',
} as const

/**
 * One block of instructions, whole, that can be read and copied. It has no border of its own: it is a group
 * inside the block that holds it. The ‹marks› of a template are coloured, so it is clear which parts are the
 * same every time and which are filled in for each task.
 */
export function PromptBlock({ prompt, query }: { prompt: AgentPrompt; query: string }) {
  const { t } = useCopy()
  const [copied, setCopied] = useState(false)
  const marks = markCount(prompt.text)

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt.text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // A browser that refuses the clipboard leaves the text there to select by hand.
    }
  }

  return (
    <section aria-label={prompt.title}>
      <SurfaceHeading
        inner
        as="h3"
        title={prompt.title}
        action={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void copy()}
            aria-label={t.promptBlock.copyTitle(prompt.title)}
          >
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied ? t.promptBlock.copied : t.promptBlock.copy}
          </Button>
        }
      />
      <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
        {prompt.when}
      </p>
      <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[12.5px] leading-relaxed text-foreground/90">
        {pieces(prompt.text, query).map((piece, i) => (
          <span key={i} className={STYLE[piece.kind]}>
            {piece.text}
          </span>
        ))}
      </pre>
      {prompt.template ? (
        <footer className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          {t.promptBlock.templatePrefix}
          <span className={STYLE.mark}>{t.promptBlock.blue}</span>
          {t.promptBlock.templateMiddle}
          {marks} {marks === 1 ? t.promptBlock.place : t.promptBlock.places}
          {t.promptBlock.templateSuffix}
        </footer>
      ) : null}
    </section>
  )
}

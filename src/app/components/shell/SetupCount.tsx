import type { SetupReport } from '../../../shared/panel'

export type SetupAttention = { count: number; tone: 'warning' | 'destructive' }

/** How many items of the setup report are not ok, and the worst of them; none while there is no report. */
export function setupAttention(report: SetupReport | undefined): SetupAttention | undefined {
  if (!report) return undefined
  const bad = report.items.filter((i) => i.status !== 'ok')
  if (bad.length === 0) return undefined
  return {
    count: bad.length,
    tone: bad.some((i) => i.status === 'missing') ? 'destructive' : 'warning',
  }
}

/** The shape every count in the menu has, so two entries with a number never look like two kinds of thing. */
export const COUNT = 'rounded px-1.5 font-mono text-[11px] font-medium tabular-nums'

// The number is the foreground on a tint of the tone: warning text on the warning fill is not read at 4.5.
export const TONE: Record<SetupAttention['tone'], string> = {
  destructive: 'bg-destructive/25 text-foreground',
  warning: 'bg-warning/25 text-foreground',
}

/** The number on the Setup entry of the menu. */
export function SetupCount({
  attention,
  className = '',
}: {
  attention: SetupAttention
  className?: string
}) {
  return (
    <span
      aria-hidden
      data-tone={attention.tone}
      className={`${className} ${COUNT} ${TONE[attention.tone]}`}
    >
      {attention.count}
    </span>
  )
}

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

// Each pair is read at 4.5 or better in both themes (palette.test.ts): warning text on the warning fill is not,
// so a warning is the text on a muted pill with a warning ring.
export const TONE: Record<SetupAttention['tone'], string> = {
  destructive: 'bg-destructive text-destructive-foreground',
  warning: 'bg-muted text-foreground ring-2 ring-inset ring-warning',
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
      className={`rounded-full px-2 text-xs ${TONE[attention.tone]} ${className}`}
    >
      {attention.count}
    </span>
  )
}

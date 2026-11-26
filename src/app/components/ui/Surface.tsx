import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link, type To } from 'react-router'
import { useWidth } from '../../lib/media'

/**
 * The one look every block of the panel has, taken from the line of the factory floor: a bordered sheet as
 * wide as the page, a heading strip, and rows parted by a hairline. A page is a `PageHeader` and a stack of
 * `Surface`s; a list is `Rows` of `Row`; numbers are `Stats`. Nothing here knows about tasks.
 */

/** The colours a block or a row may carry, by what they say and never by where they are used. */
export type Tone = 'neutral' | 'primary' | 'warning' | 'info' | 'success' | 'destructive'

export const TONE_DOT: Record<Tone, string> = {
  neutral: 'bg-muted-foreground/50',
  primary: 'bg-primary',
  warning: 'bg-warning',
  info: 'bg-info',
  success: 'bg-success',
  destructive: 'bg-destructive',
}

/**
 * The colour of an icon that stands for a state. An icon is a picture, which reads at a contrast of 3, where
 * a word needs 4.5 and none of these colours reaches it in both modes: so a state colours a dot, a tile or an
 * icon, and the words beside it stay in the foreground. The accent is under 3 on a card in dark mode, so an
 * icon in it stays in the foreground too.
 */
export const TONE_ICON: Record<Tone, string> = {
  neutral: 'stroke-muted-foreground',
  primary: 'stroke-foreground',
  warning: 'stroke-warning',
  info: 'stroke-info',
  success: 'stroke-success',
  destructive: 'stroke-destructive',
}

const TONE_TILE: Record<Tone, string> = {
  neutral: 'bg-muted',
  primary: 'bg-primary/15',
  warning: 'bg-warning/15',
  info: 'bg-info/15',
  success: 'bg-success/15',
  destructive: 'bg-destructive/15',
}

/** The space between the blocks of a page. */
export const STACK = 'space-y-4'

/** How wide running text and form fields get inside a block: a block spans the page, a sentence does not. */
export const READABLE = 'max-w-3xl'

/** The top of a page: its name, one sentence about it, and what the owner can do from there. */
export function PageHeader({
  title,
  lede,
  above,
  actions,
}: {
  title: ReactNode
  lede?: ReactNode
  /** A way back, over the title. */
  above?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {above ? <div className="mb-1 text-sm text-muted-foreground">{above}</div> : null}
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {lede ? <p className={`mt-1 text-sm text-muted-foreground ${READABLE}`}>{lede}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  )
}

/**
 * A page that keeps the height of the window on a wide screen: what is in `header` stays, and each `Pane`
 * under it scrolls by itself, so the page never does. On a narrower screen it is the stack it always was.
 */
export function Workbench({
  header,
  columns = 'grid-cols-1',
  footer,
  children,
}: {
  header?: ReactNode
  /** The grid columns of the panes, as a whole class (`grid-cols-[280px_minmax(0,1fr)]`). */
  columns?: string
  /** A line that stays under the panes, like a pager. */
  footer?: ReactNode
  children: ReactNode
}) {
  const wide = useWidth() === 'expanded'
  return (
    <div
      data-layout={wide ? 'workbench' : 'stack'}
      className={wide ? 'flex h-[calc(100vh-8.75rem)] flex-col' : undefined}
    >
      {header}
      <div
        className={wide ? `grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] gap-4 ${columns}` : STACK}
      >
        {children}
      </div>
      {footer}
    </div>
  )
}

/** One column of a `Workbench`: its blocks stacked, scrolling inside the column. */
export function Pane({ children, label }: { children: ReactNode; label?: string }) {
  const wide = useWidth() === 'expanded'
  return (
    <div
      data-pane=""
      aria-label={label}
      className={wide ? `min-h-0 min-w-0 overflow-y-auto pr-1 ${STACK}` : `min-w-0 ${STACK}`}
    >
      {children}
    </div>
  )
}

/** The strip a block or a group of rows starts with: a mark, a name, how many, a few words, and an action. */
export function SurfaceHeading({
  title,
  icon: Icon,
  tone,
  count,
  lede,
  action,
  as: Tag = 'h2',
  inner = false,
}: {
  title: ReactNode
  icon?: LucideIcon
  /** A dot in this colour before the name, for a group that means a state. */
  tone?: Tone
  count?: number
  lede?: ReactNode
  action?: ReactNode
  as?: 'h2' | 'h3'
  /** A group inside a block, tinted, as opposed to the heading of the block. */
  inner?: boolean
}) {
  return (
    <div
      className={`flex min-h-10 items-center gap-2 border-b border-border px-4 py-2 ${inner ? 'bg-muted/40' : ''}`}
    >
      {tone ? (
        <span aria-hidden className={`size-2.5 shrink-0 rounded-full ${TONE_DOT[tone]}`} />
      ) : null}
      {Icon ? <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" /> : null}
      <Tag className="shrink-0 text-sm font-semibold">{title}</Tag>
      {count !== undefined ? (
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{count}</span>
      ) : null}
      {lede ? (
        <span className="ml-1 min-w-0 truncate text-xs text-muted-foreground">{lede}</span>
      ) : null}
      {action ? (
        <span className="ml-auto flex shrink-0 items-center gap-2 text-xs">{action}</span>
      ) : null}
    </div>
  )
}

/**
 * One block of a page: as wide as the page, bordered, with its heading strip. `label` names it for a screen
 * reader when it has no visible title; `padded` is for content that is not rows (a form, a paragraph).
 */
export function Surface({
  title,
  icon,
  tone,
  count,
  lede,
  action,
  label,
  padded = false,
  fill = false,
  className = '',
  children,
}: {
  /** Takes the height its parent leaves, so what is inside scrolls and the block does not grow. */
  fill?: boolean
  title?: ReactNode
  icon?: LucideIcon
  tone?: Tone
  count?: number
  lede?: ReactNode
  action?: ReactNode
  label?: string
  padded?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <section
      aria-label={label ?? (typeof title === 'string' ? title : undefined)}
      className={`w-full overflow-hidden rounded-xl border border-border bg-card ${fill ? 'flex min-h-0 flex-1 flex-col' : ''} ${className}`}
    >
      {title ? (
        <SurfaceHeading
          title={title}
          icon={icon}
          tone={tone}
          count={count}
          lede={lede}
          action={action}
        />
      ) : null}
      {padded ? (
        <div className={`space-y-3 p-4 ${fill ? 'flex min-h-0 flex-1 flex-col' : ''}`}>
          {children}
        </div>
      ) : (
        children
      )}
    </section>
  )
}

/** The rows of a block, parted by a hairline. */
export function Rows({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <ul aria-label={label} className="divide-y divide-border">
      {children}
    </ul>
  )
}

/** A square mark that starts a row, in the colour of what the row says. */
export function RowIcon({ icon: Icon, tone = 'neutral' }: { icon: LucideIcon; tone?: Tone }) {
  return (
    <span
      className={`grid size-7 shrink-0 place-items-center rounded-md ${TONE_TILE[tone]}`}
      aria-hidden
    >
      <Icon className={`size-4 ${TONE_ICON[tone]}`} />
    </span>
  )
}

const ROW = 'flex w-full items-center gap-3 px-4 py-2.5 text-left'

/**
 * One row: what starts it, a title with a line of detail under it, and what ends it on the right. With `to`
 * the whole row is a link, so nothing inside it may be a link or a button; `below` goes under the row, outside
 * the link, for what can be clicked.
 */
export function Row({
  to,
  href,
  lead,
  title,
  meta,
  detail,
  trail,
  below,
  current = false,
  children,
}: {
  /** The row the page beside it is about. */
  current?: boolean
  to?: To
  /** An address outside the panel, opened in a new tab. */
  href?: string
  lead?: ReactNode
  title?: ReactNode
  /** The small line in the mono face under the title: where, which, when. */
  meta?: ReactNode
  /** A sentence under the title, which may wrap. */
  detail?: ReactNode
  trail?: ReactNode
  below?: ReactNode
  /** In place of title, meta and detail, for a row with a shape of its own. */
  children?: ReactNode
}) {
  const body = (
    <>
      {lead}
      <span className="min-w-0 flex-1">
        {children ?? (
          <>
            {title ? <span className="block truncate text-sm font-medium">{title}</span> : null}
            {meta ? (
              <span className="block truncate font-mono text-[11px] text-muted-foreground">
                {meta}
              </span>
            ) : null}
            {detail ? (
              <span className="mt-0.5 block whitespace-pre-wrap text-[13px] text-foreground/80">
                {detail}
              </span>
            ) : null}
          </>
        )}
      </span>
      {trail ? (
        <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
          {trail}
        </span>
      ) : null}
    </>
  )
  const focus = 'hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring'
  return (
    <li>
      {to ? (
        <Link
          to={to}
          aria-current={current ? 'true' : undefined}
          className={`${ROW} ${focus} ${current ? 'bg-muted/60' : ''}`}
        >
          {body}
        </Link>
      ) : href ? (
        <a href={href} target="_blank" rel="noreferrer" className={`${ROW} ${focus}`}>
          {body}
        </a>
      ) : (
        <div
          aria-current={current ? 'true' : undefined}
          className={`${ROW} ${current ? 'bg-muted/60' : ''}`}
        >
          {body}
        </div>
      )}
      {below ? <div className="px-4 pb-3">{below}</div> : null}
    </li>
  )
}

/** What a block says when it has no row, or while it loads. */
export function Quiet({ children, role }: { children: ReactNode; role?: 'status' }) {
  return (
    <p role={role} className="px-4 py-3 text-sm text-muted-foreground">
      {children}
    </p>
  )
}

/** A few numbers side by side in one block, each under its name. */
export function Stats({
  items,
  label,
}: {
  items: { label: ReactNode; value: ReactNode; note?: ReactNode; icon?: LucideIcon }[]
  label?: string
}) {
  return (
    <dl
      aria-label={label}
      className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] divide-x divide-border"
    >
      {items.map(({ label: name, value, note, icon: Icon }, index) => (
        <div key={index} className="px-4 py-3">
          <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {Icon ? <Icon aria-hidden className="size-3.5" /> : null}
            {name}
          </dt>
          <dd className="mt-1 font-mono text-lg font-semibold tabular-nums">{value}</dd>
          {note ? <dd className="text-xs text-muted-foreground">{note}</dd> : null}
        </div>
      ))}
    </dl>
  )
}

/** The classes of a table inside a block, so every table of the panel has the same rhythm. */
export const TABLE = {
  table: 'w-full text-left text-sm',
  head: 'border-b border-border font-mono text-[11px] uppercase tracking-wider text-muted-foreground',
  th: 'px-4 py-2 font-normal',
  row: 'border-b border-border last:border-b-0 hover:bg-muted/40',
  td: 'px-4 py-2',
  number: 'px-4 py-2 text-right font-mono tabular-nums',
}

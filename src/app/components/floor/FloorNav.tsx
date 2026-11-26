import { FolderGit2, type LucideIcon, UserRound, Workflow, Zap } from 'lucide-react'
import { NavLink } from 'react-router'

import { useCopy } from '../../lib/copy'

const tab = (active: boolean) =>
  `-mb-px flex items-center gap-2 border-b-2 px-3 pb-2.5 pt-1 text-sm font-medium transition-colors ${active ? 'border-primary text-foreground' : 'border-transparent text-foreground/60 hover:text-foreground'}`

/** The four views of the floor, and how many tasks wait for the owner. */
export function FloorNav({ waiting }: { waiting: number }) {
  const { t } = useCopy()
  const views: { to: string; label: string; icon: LucideIcon; end?: boolean; count?: number }[] = [
    { to: '/floor', label: t.floor.views.line, icon: Workflow, end: true },
    { to: '/floor/attention', label: t.floor.views.attention, icon: UserRound, count: waiting },
    { to: '/floor/decisions', label: t.floor.views.decisions, icon: Zap },
    { to: '/floor/projects', label: t.floor.views.projects, icon: FolderGit2 },
  ]
  return (
    <nav aria-label={t.floor.heading} className="mb-5 flex flex-wrap gap-1 border-b border-border">
      {views.map((view) => (
        <NavLink
          key={view.to}
          to={view.to}
          end={view.end}
          className={({ isActive }) => tab(isActive)}
        >
          <view.icon aria-hidden className="size-4" />
          {view.label}
          {view.count ? (
            <span className="rounded-full bg-warning/25 px-2 font-mono text-[11px] text-foreground">
              {view.count}
            </span>
          ) : null}
        </NavLink>
      ))}
    </nav>
  )
}

/** The heading every view of the floor starts with. */
export function FloorHeading({
  title,
  lede,
  waiting,
}: {
  title: string
  lede: string
  waiting: number
}) {
  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <p className="mb-4 mt-1 max-w-[68ch] text-sm text-muted-foreground">{lede}</p>
      <FloorNav waiting={waiting} />
    </>
  )
}

import { Bot, Box, type LucideIcon, MessagesSquare } from 'lucide-react'

import type { AgentEntry } from '../../../shared/panel'
import { GROUPS } from '../../lib/agents'
import { useCopy } from '../../lib/copy'
import { ROLE_ICON } from '../floor/icons'
import { Surface, SurfaceHeading } from '../ui/Surface'

const ICONS: Record<string, LucideIcon> = ROLE_ICON

/** The picture of an agent: the one of its role on the line, or a robot for an assistant of the panel. */
export const agentIcon = (id: string): LucideIcon => ICONS[id] ?? Bot

/** The agents in two groups, the chosen one marked. A group with none left by the search is not shown. */
export function AgentList({
  agents,
  selected,
  onSelect,
}: {
  agents: AgentEntry[]
  selected: string | undefined
  onSelect: (id: string) => void
}) {
  const { t } = useCopy()
  return (
    <nav aria-label={t.agents.heading}>
      <Surface>
        {GROUPS.map((group) => {
          const inGroup = agents.filter((a) => a.group === group.id)
          if (inGroup.length === 0) return null
          return (
            <section
              key={group.id}
              aria-label={t.agentGroups[group.id].title}
              className="border-b border-border last:border-b-0"
            >
              <SurfaceHeading
                inner
                icon={group.id === 'factory' ? Box : MessagesSquare}
                title={t.agentGroups[group.id].title}
              />
              <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
                {t.agentGroups[group.id].about}
              </p>
              <ul className="divide-y divide-border">
                {inGroup.map((agent) => {
                  const active = agent.id === selected
                  const Icon = agentIcon(agent.id)
                  return (
                    <li key={agent.id}>
                      {/* A row that chooses instead of leading somewhere, so it is a button and not a Row. */}
                      <button
                        type="button"
                        aria-current={active ? 'true' : undefined}
                        onClick={() => onSelect(agent.id)}
                        className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring ${active ? 'bg-muted font-medium text-foreground' : 'text-foreground/85 hover:bg-muted/40'}`}
                      >
                        <span
                          aria-hidden
                          className={`grid size-7 shrink-0 place-items-center rounded-md ${active ? 'bg-primary/15 text-foreground' : 'bg-muted text-muted-foreground'}`}
                        >
                          <Icon className="size-4" />
                        </span>
                        <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                        {agent.prompts.length > 1 ? (
                          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                            {agent.prompts.length}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
      </Surface>
    </nav>
  )
}

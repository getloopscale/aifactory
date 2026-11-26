import { Users } from 'lucide-react'
import { Link } from 'react-router'

import type { AgentRole, AgentsView, RoleModels } from '../../../shared/panel'
import { useCopy } from '../../lib/copy'
import { useResource } from '../../lib/live'
import { Row, RowIcon, Rows, Surface } from '../ui/Surface'

import { AgentIcon } from './AgentIcon'
import { ROLE_ICON } from './icons'

const ROLES: AgentRole[] = ['planner', 'builder', 'reviewer', 'security', 'merger']

/** Which tool does each job right now, and with which model, as the agent settings say. */
export function Crew() {
  const { t } = useCopy()
  const settings = useResource<AgentsView>('/api/panel/agents', {
    everyMs: 120_000,
    stream: false,
  })
  const ran = useResource<{ models: RoleModels }>('/api/panel/agents/models', {
    everyMs: 120_000,
    stream: false,
  })
  /** The model the owner chose for the role, else the one its agent last reported running with. */
  const modelOf = (role: AgentRole, agent: string) => {
    const last = ran.data?.models[role]
    return (
      settings.data?.settings.chosenModel[role] ??
      (last?.agent === agent ? last.model : t.floor.defaultModel)
    )
  }
  return (
    <Surface
      title={t.floor.crew.heading}
      icon={Users}
      action={
        <Link to="/agents" className="text-muted-foreground underline underline-offset-2">
          {t.floor.crew.change}
        </Link>
      }
    >
      {settings.error ? (
        <p className="px-4 py-3 text-sm text-destructive">{settings.error}</p>
      ) : null}
      {settings.data ? (
        <Rows>
          {ROLES.map((role) => {
            const agent = settings.data!.settings.effective[role]
            return (
              <Row key={role} lead={<RowIcon icon={ROLE_ICON[role]} />}>
                <span className="flex items-center gap-2.5">
                  <span className="w-16 shrink-0 text-xs text-foreground/80">
                    {t.floor.crew.roles[role]}
                  </span>
                  <AgentIcon agent={agent} size="sm" />
                  <span className="min-w-0 truncate font-mono text-[12px] font-medium">
                    {modelOf(role, agent)}
                  </span>
                </span>
              </Row>
            )
          })}
        </Rows>
      ) : null}
    </Surface>
  )
}

import { Badge, Progress } from '@usetheo/ui'
import { Bot, Coins, FolderGit2 } from 'lucide-react'
import { useMemo } from 'react'

import type {
  HealthReport,
  InboxItem,
  MetricRow,
  MetricsReport,
  TaskCard,
} from '../../../shared/panel'
import { AgentIcon } from '../../components/floor/AgentIcon'
import { FloorHeading } from '../../components/floor/FloorNav'
import { ROLE_ICON } from '../../components/floor/icons'
import { StatePill } from '../../components/floor/StageTape'
import {
  Pane,
  Quiet,
  Row,
  RowIcon,
  Rows,
  Surface,
  TABLE,
  Workbench,
} from '../../components/ui/Surface'
import { useCopy } from '../../lib/copy'
import { ownerTasks, stateOf, type FloorState } from '../../lib/floor'
import { duration, metricValue, money } from '../../lib/format'
import { useResource } from '../../lib/live'

/** The indicators a project row shows, in this order, when the repository has a point for them. */
const SHOWN = [
  'first_review_approval',
  'rework_rounds',
  'minutes_to_delivery',
  'handoff_share',
  'cost_per_delivery',
]
const OPEN: FloorState[] = ['moving', 'owner', 'factory', 'queued']

type Project = { repository: string; open: Record<FloorState, number>; metrics: MetricRow[] }

const active = (project: Project) => OPEN.reduce((sum, state) => sum + project.open[state], 0)
/** An average pass, in seconds under a minute: a review is often shorter than one. */
const passTime = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : duration(ms / 60_000))

/** Each repository by itself: what is open, what was delivered today and how its indicators stand. */
export default function FloorProjectsPage() {
  const { t } = useCopy()
  const tasks = useResource<{ tasks: TaskCard[] }>('/api/panel/tasks')
  const inbox = useResource<{ items: InboxItem[] }>('/api/panel/inbox')
  const metrics = useResource<MetricsReport>('/api/panel/metrics', {
    everyMs: 60_000,
    stream: false,
  })
  const health = useResource<HealthReport>('/api/panel/health', { everyMs: 60_000, stream: false })

  const waits = useMemo(() => ownerTasks(inbox.data?.items ?? []), [inbox.data])
  const projects = useMemo(() => {
    const byRepository = new Map<string, Project>()
    const of = (repository: string) => {
      let project = byRepository.get(repository)
      if (!project) {
        project = {
          repository,
          open: { moving: 0, owner: 0, factory: 0, queued: 0, delivered: 0 },
          metrics: [],
        }
        byRepository.set(repository, project)
      }
      return project
    }
    for (const task of tasks.data?.tasks ?? []) {
      const state = stateOf(task, waits)
      const project = of(task.repository)
      project.open[state] += 1
    }
    for (const row of metrics.data?.rows ?? []) {
      if (row.repository !== '*' && SHOWN.includes(row.metric)) of(row.repository).metrics.push(row)
    }
    return [...byRepository.values()].sort(
      (a, b) => active(b) - active(a) || a.repository.localeCompare(b.repository),
    )
  }, [tasks.data, metrics.data, waits])

  /** The indicators that have a point somewhere, each with its name: the columns of the table. */
  const columns = useMemo(() => {
    const labels = new Map<string, string>()
    for (const row of metrics.data?.rows ?? []) labels.set(row.metric, row.label)
    return SHOWN.filter((name) => labels.has(name)).map((name) => ({
      name,
      label: labels.get(name),
    }))
  }, [metrics.data])

  const roles = useMemo(() => {
    const byRole = new Map<
      string,
      { costUsd: number; runs: number; unpriced: number; ms: number; tools: Set<string> }
    >()
    for (const group of health.data?.cost.groups ?? []) {
      const role = byRole.get(group.role) ?? {
        costUsd: 0,
        runs: 0,
        unpriced: 0,
        ms: 0,
        tools: new Set<string>(),
      }
      role.tools.add(group.harness)
      role.costUsd += group.costUsd
      role.runs += group.runs
      role.unpriced += group.runs - group.reportedRuns
      role.ms += group.avgDurationMs * group.runs
      byRole.set(group.role, role)
    }
    return [...byRole.entries()].sort((a, b) => b[1].costUsd - a[1].costUsd)
  }, [health.data])
  const topCost = Math.max(0.01, ...roles.map(([, role]) => role.costUsd))
  const error = tasks.error ?? metrics.error ?? health.error

  return (
    <Workbench
      columns="grid-cols-[minmax(0,7fr)_minmax(360px,5fr)]"
      header={
        <>
          <FloorHeading
            title={t.floor.projects.heading}
            lede={t.floor.projects.lede}
            waiting={ownerTasks(inbox.data?.items ?? []).size}
          />
          {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}
        </>
      }
    >
      <Pane label={t.floor.projects.heading}>
        <Surface
          title={t.floor.projects.heading}
          icon={FolderGit2}
          count={tasks.data ? projects.length : undefined}
        >
          {tasks.data ? (
            <div className="overflow-x-auto">
              <table className={TABLE.table}>
                <thead className={TABLE.head}>
                  <tr>
                    <th scope="col" className={TABLE.th}>
                      {t.floor.projects.heading}
                    </th>
                    {columns.map((column) => (
                      <th key={column.name} scope="col" className={`${TABLE.th} text-right`}>
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {projects.map((project) => (
                    <tr key={project.repository} className={TABLE.row}>
                      <th scope="row" className={`${TABLE.td} font-normal`}>
                        <span className="block whitespace-nowrap font-medium">
                          {project.repository}
                        </span>
                        <span className="mt-1 flex flex-wrap gap-1.5">
                          {OPEN.filter((state) => project.open[state] > 0).map((state) => (
                            <StatePill
                              key={state}
                              state={state}
                              label={`${project.open[state]} ${t.floor.states[state]}`}
                            />
                          ))}
                          {active(project) === 0 ? (
                            <span className="text-xs text-muted-foreground">
                              {t.floor.projects.nothingOpen}
                            </span>
                          ) : null}
                        </span>
                      </th>
                      {project.metrics.length === 0 && columns.length > 0 ? (
                        <td
                          colSpan={columns.length}
                          className={`${TABLE.td} text-right text-xs text-muted-foreground`}
                        >
                          {t.floor.projects.noMetrics}
                        </td>
                      ) : (
                        columns.map((column) => {
                          const row = project.metrics.find((each) => each.metric === column.name)
                          return (
                            <td key={column.name} className={`${TABLE.number} align-top`}>
                              {row ? (
                                <>
                                  <span className="block whitespace-nowrap">
                                    {metricValue(row.value, row.unit)}
                                  </span>
                                  {row.mean !== null ? (
                                    <span className="block whitespace-nowrap text-[11px] text-muted-foreground">
                                      {t.floor.projects.usual(metricValue(row.mean, row.unit))}
                                    </span>
                                  ) : null}
                                  {row.band === 'show' || row.band === 'act' ? (
                                    <Badge variant="warning">{t.floor.projects.outOfBand}</Badge>
                                  ) : null}
                                </>
                              ) : null}
                            </td>
                          )
                        })
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
              {columns.length === 0 && projects.length > 0 ? (
                <Quiet>{t.floor.projects.noMetrics}</Quiet>
              ) : null}
            </div>
          ) : (
            <Quiet>{t.layout.loading}</Quiet>
          )}
        </Surface>
      </Pane>
      <Pane label={t.floor.projects.costByRole}>
        <Surface
          title={t.floor.projects.costByRole}
          icon={Coins}
          lede={t.floor.projects.costByRoleLede}
        >
          <Rows>
            {roles.map(([name, role]) => (
              <Row
                key={name}
                lead={<RowIcon icon={ROLE_ICON[name as keyof typeof ROLE_ICON] ?? Bot} />}
                trail={
                  <span className="font-mono text-[11px] tabular-nums">
                    {money(role.costUsd)} · {t.floor.projects.runs(role.runs)} ·{' '}
                    {passTime(role.runs ? role.ms / role.runs : 0)}
                    {role.unpriced > 0 ? ` · ${t.floor.projects.unpriced(role.unpriced)}` : ''}
                  </span>
                }
              >
                <span className="mb-1.5 flex items-center gap-2 text-sm font-medium">
                  {name}
                  {[...role.tools].sort().map((tool) => (
                    <AgentIcon key={tool} agent={tool} size="sm" />
                  ))}
                </span>
                <Progress
                  value={role.costUsd}
                  max={topCost}
                  height="h-2"
                  aria-label={`${name} ${money(role.costUsd)}`}
                />
              </Row>
            ))}
          </Rows>
        </Surface>
      </Pane>
    </Workbench>
  )
}

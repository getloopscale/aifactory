import { Card } from '@usetheo/ui'
import type { ReactNode } from 'react'
import { Link, useParams } from 'react-router'

import type { RepositoryDetail } from '../../../../shared/panel'
import { useCopy } from '../../../lib/copy'
import { ago, money } from '../../../lib/format'
import { useResource } from '../../../lib/live'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <Card size="sm" className="p-4">
        <h2 className="mb-2 font-medium">{title}</h2>
        {children}
      </Card>
    </section>
  )
}

const Empty = ({ text }: { text: string }) => (
  <p className="text-sm text-muted-foreground">{text}</p>
)
const percent = (share: number) => `${Math.round(share * 100)}%`

/** One repository: its runs, findings, indicators, the cost by role and how its reviews went. */
export default function RepositoryPage() {
  const { owner, name } = useParams()
  const { t } = useCopy()
  const c = t.repositoryDetail
  const resource = useResource<RepositoryDetail>(`/api/panel/repositories/${owner}/${name}`, {
    everyMs: 30_000,
    stream: false,
  })
  const d = resource.data
  return (
    <div className="space-y-4">
      <Link to="/repositories" className="text-sm text-muted-foreground hover:text-foreground">
        {c.back}
      </Link>
      <h1 className="text-xl font-semibold">
        {owner}/{name}
      </h1>
      {resource.error ? <p className="text-sm text-destructive">{c.notFound}</p> : null}
      {!d && !resource.error ? <p className="text-sm text-muted-foreground">{c.loading}</p> : null}
      {d ? (
        <>
          <Section title={c.runs}>
            {d.tasks.length === 0 ? (
              <Empty text={c.noTasks} />
            ) : (
              <ul className="flex flex-wrap gap-3 text-sm">
                {d.tasks.map((s) => (
                  <li key={s.stage}>
                    {t.stages[s.stage as keyof typeof t.stages] ?? s.stage}: {s.count}
                  </li>
                ))}
              </ul>
            )}
            <h3 className="mb-1 mt-3 text-sm font-medium">{c.passes}</h3>
            {d.passes.length === 0 ? (
              <Empty text={c.noPasses} />
            ) : (
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="py-1 pr-3">{c.task}</th>
                    <th className="py-1 pr-3">{c.role}</th>
                    <th className="py-1 pr-3">{c.agent}</th>
                    <th className="py-1 pr-3">{c.model}</th>
                    <th className="py-1 pr-3">{c.time}</th>
                    <th className="py-1 pr-3">{c.cost}</th>
                    <th className="py-1 pr-3">{c.result}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.passes.map((p) => (
                    <tr key={p.id} className="border-t border-border">
                      <td className="py-1 pr-3">
                        <Link to={`/tasks/${p.taskId}`} className="underline underline-offset-2">
                          #{p.issueNumber}
                        </Link>
                      </td>
                      <td className="py-1 pr-3">{p.role}</td>
                      <td className="py-1 pr-3">{p.harness}</td>
                      <td className="py-1 pr-3">{p.model ?? ''}</td>
                      <td className="py-1 pr-3">{c.seconds((p.durationMs / 1000).toFixed(1))}</td>
                      <td className="py-1 pr-3">
                        {p.costUsd === null ? (
                          <span className="text-muted-foreground">{c.unknownCost}</span>
                        ) : (
                          money(p.costUsd)
                        )}
                      </td>
                      <td className="py-1 pr-3">{p.ok ? c.ok : c.failed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
          <Section title={c.findings}>
            {d.findings.length === 0 ? (
              <Empty text={c.noFindings} />
            ) : (
              <ul className="space-y-1 text-sm">
                {d.findings.map((f) => (
                  <li key={f.id}>
                    {f.detail}{' '}
                    <span className="text-muted-foreground">
                      {ago(f.firstSeenAt, Date.now(), t.time)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <h3 className="mb-1 mt-3 text-sm font-medium">{c.patterns}</h3>
            {d.patterns.length === 0 ? (
              <Empty text={c.noPatterns} />
            ) : (
              <ul className="space-y-1 text-sm">
                {d.patterns.map((p) => (
                  <li key={p.id}>
                    <span className="font-medium">{p.className}</span>: {p.invariant}
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title={c.indicators}>
            {d.indicators.length === 0 ? (
              <Empty text={c.noIndicators} />
            ) : (
              <div className="space-y-3 text-sm">
                {d.indicators.map((i) => (
                  <div key={i.metric}>
                    <div className="font-medium">{i.label}</div>
                    <ul className="flex flex-wrap gap-2">
                      {i.days.map((day) => (
                        <li key={day.day} title={day.day}>
                          <span className="text-muted-foreground">{day.day.slice(5)}</span>{' '}
                          {day.value === null ? (
                            <span className="text-muted-foreground">{c.gap}</span>
                          ) : (
                            <>
                              {Number(day.value.toFixed(2))}{' '}
                              <span className="text-muted-foreground">
                                ({c.samples(day.samples ?? 0)})
                              </span>
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </Section>
          <Section title={c.costByRole}>
            {d.costByRole.length === 0 ? (
              <Empty text={c.noCost} />
            ) : (
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="py-1 pr-3">{c.role}</th>
                    <th className="py-1 pr-3">{c.passCount}</th>
                    <th className="py-1 pr-3">{c.cost}</th>
                    <th className="py-1 pr-3">{c.unknownShare}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.costByRole.map((r) => (
                    <tr key={r.role} className="border-t border-border">
                      <td className="py-1 pr-3">{r.role}</td>
                      <td className="py-1 pr-3">{r.passes}</td>
                      <td className="py-1 pr-3">{money(r.costUsd)}</td>
                      <td className="py-1 pr-3">{percent(r.unknownShare)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
          <Section title={c.reviewRounds}>
            {d.reviewRounds.length === 0 ? (
              <Empty text={c.noReviews} />
            ) : (
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="py-1 pr-3">{c.reviewer}</th>
                    <th className="py-1 pr-3">{c.reviewedTasks}</th>
                    <th className="py-1 pr-3">{c.plateau}</th>
                    <th className="py-1 pr-3">{c.changesPerTask}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.reviewRounds.map((r) => (
                    <tr key={r.reviewer} className="border-t border-border">
                      <td className="py-1 pr-3">{r.reviewer}</td>
                      <td className="py-1 pr-3">{r.tasks}</td>
                      <td className="py-1 pr-3">{percent(r.plateauShare)}</td>
                      <td className="py-1 pr-3">{r.changesPerTask.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
        </>
      ) : null}
    </div>
  )
}

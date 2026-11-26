import {
  Bot,
  CircleHelp,
  Eye,
  FlaskConical,
  History,
  PackageCheck,
  Rocket,
  ShieldCheck,
  Workflow,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'

import {
  type ReviewView,
  type RunView,
  type TaskDetail,
  type TimelineEvent,
} from '../../shared/panel'
import { Pass, StageBadge } from './Badges'
import { CoordinatorActions } from './CoordinatorActions'
import { PlanSection } from './PlanSection'
import { WatchPanel } from './WatchPanel'
import { Conversation } from './Conversation'
import { TaskActions } from './TaskActions'
import { useTranscript } from './Transcript'
import { AgentIcon } from './floor/AgentIcon'
import {
  PageHeader,
  Quiet,
  READABLE,
  Row,
  RowIcon,
  Rows,
  STACK,
  Surface,
  TABLE,
} from './ui/Surface'
import { ago, describeEvent, itemName, money, shortSha } from '../lib/format'
import { useCopy } from '../lib/copy'
import { useResource } from '../lib/live'
import { useWidth } from '../lib/media'

/** Inside the frame of a tabbed task, the well its blocks sit in, under the head. */
const WELL = 'flex min-w-0 flex-col gap-3 bg-background px-3 pb-3'

const TASK_TABS = ['activity', 'runs', 'evidence', 'reviews'] as const
/** In one column the conversation is a tab too, and the first. */
const PANES = ['conversation', ...TASK_TABS] as const
type TaskTab = (typeof PANES)[number]

/**
 * One tab of the task's side: beside the conversation only the chosen one shows, and the others stay in the
 * page; stacked, every one shows.
 */
function TaskPane({
  id,
  active,
  split,
  children,
}: {
  id: TaskTab
  active: TaskTab
  split: boolean
  children: ReactNode
}) {
  return (
    <div
      data-pane={id}
      className={
        split ? (active === id ? `min-h-0 flex-1 overflow-y-auto ${STACK}` : 'hidden') : STACK
      }
    >
      {children}
    </div>
  )
}

/**
 * Everything about one task: where it is, what it cost, what it did, and what a person can do. It is
 * shown in the side panel of the board and as a page of its own, so it takes the heading above it
 * (the way back) from whoever shows it.
 */
export function TaskDetailView({
  id,
  above,
  focusRun,
  workbench = false,
  tabbed = false,
}: {
  id: number
  /** On a page of its own and a wide screen: the conversation beside the rest, which is in tabs. */
  workbench?: boolean
  /** In a column that has a height of its own: one tab at a time, the conversation first, each filling it. */
  tabbed?: boolean
  above?: ReactNode
  /** The pass to open the conversation at. */
  focusRun?: number
}) {
  const { t } = useCopy()
  const resource = useResource<TaskDetail>(`/api/panel/tasks/${id}`, { only: id })
  const detail = resource.data
  const transcript = useTranscript(id)
  const wide = useWidth() === 'expanded'
  const beside = workbench && wide && !tabbed
  /** Tabs take the place of the stack, beside the conversation or over it. */
  const split = beside || tabbed
  const [picked, setTab] = useState<TaskTab>()
  const tab: TaskTab = picked ?? (tabbed ? 'conversation' : 'activity')
  const talking = tabbed && tab === 'conversation'

  if (resource.error) return <p className="text-sm text-destructive">{resource.error}</p>
  if (!detail) return <p className="text-sm text-muted-foreground">{t.task.loading}</p>
  const { task } = detail

  const counts: Record<TaskTab, number> = {
    conversation: 0,
    activity: detail.timeline.length,
    runs: detail.runs.length,
    evidence: detail.evidence.length,
    reviews: detail.reviews.length + detail.securityReviews.length,
  }

  const tabs = (
    <div
      role="tablist"
      aria-label={t.task.tabs.label}
      className={
        tabbed
          ? 'flex gap-1 overflow-x-auto overflow-y-hidden border-t border-border px-2'
          : 'flex gap-1 rounded-xl border border-border bg-card p-1'
      }
    >
      {(tabbed ? PANES : TASK_TABS).map((name) => (
        <button
          key={name}
          type="button"
          role="tab"
          aria-selected={tab === name}
          onClick={() => setTab(name)}
          className={
            tabbed
              ? `-mb-px flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-[13px] transition-colors ${
                  tab === name
                    ? 'border-primary font-medium text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`
              : `flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 text-[13px] transition-colors ${
                  tab === name
                    ? 'bg-muted font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                }`
          }
        >
          {t.task.tabs[name]}
          {counts[name] > 0 ? (
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
              {counts[name]}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  )

  return (
    <div
      data-layout={beside ? 'workbench' : tabbed ? 'tabbed' : 'stack'}
      className={
        beside
          ? 'grid h-full min-h-0 grid-cols-[minmax(0,1fr)_minmax(380px,34%)] gap-4'
          : tabbed
            ? // One frame for the head, the tabs and what the chosen tab shows: they open and close together.
              'flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card'
            : STACK
      }
    >
      <div
        className={
          tabbed
            ? `${WELL} ${talking ? 'min-h-0 flex-1' : 'shrink-0'}`
            : beside
              ? 'flex min-h-0 min-w-0 flex-1 flex-col gap-4'
              : `min-w-0 ${STACK}`
        }
      >
        {tabbed ? (
          // One sheet for the whole head, as every block of the factory: a strip that says which task and
          // where it is, its name and facts, and the tabs as the sheet's last line.
          <header className="-mx-3 shrink-0 border-b border-border bg-card">
            <div className="flex items-center gap-3 border-b border-border bg-muted/40 px-4 py-2 text-sm text-muted-foreground">
              <span className="font-mono text-xs">
                {task.repository} {itemName(task)}
              </span>
              <StageBadge
                stage={task.stage}
                integrated={task.integrated}
                waitingForChecks={task.waitingForChecks}
                resolved={task.resolved}
                retryable={task.retryable}
              />
              <span className="ml-auto flex shrink-0 items-center">{above}</span>
            </div>
            <div className="px-4 py-3">
              <h1 className="line-clamp-2 text-[15px] font-semibold leading-snug tracking-tight">
                {task.title}
              </h1>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                <span className="font-mono text-xs tabular-nums">{money(task.costUsd)}</span>
                {task.attempts > 0 ? <span>{t.task.attempts(task.attempts)}</span> : null}
                {task.headSha ? <code className="text-xs">{shortSha(task.headSha)}</code> : null}
                {task.preRelease ? (
                  <a
                    href={task.preRelease.url}
                    className="text-foreground underline underline-offset-2"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t.task.preRelease(task.preRelease.tag)}
                  </a>
                ) : null}
                {task.release ? (
                  <a
                    href={task.release.url}
                    className="font-medium text-foreground underline underline-offset-2"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t.task.release(task.release.tag)}
                  </a>
                ) : null}
                {task.pullRequestUrl ? (
                  <a
                    href={task.pullRequestUrl}
                    className="text-foreground underline underline-offset-2"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t.task.pullRequest}
                  </a>
                ) : null}
              </div>
            </div>
            {tabs}
          </header>
        ) : (
          <div>
            <PageHeader title={task.title} above={above} />
            <div className="-mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <span className="font-mono text-xs">
                {task.repository} {itemName(task)}
              </span>
              <StageBadge
                stage={task.stage}
                integrated={task.integrated}
                waitingForChecks={task.waitingForChecks}
                resolved={task.resolved}
                retryable={task.retryable}
              />
              <span className="font-mono text-xs tabular-nums">{money(task.costUsd)}</span>
              {task.attempts > 0 ? <span>{t.task.attempts(task.attempts)}</span> : null}
              {task.headSha ? <code className="text-xs">{shortSha(task.headSha)}</code> : null}
              {task.preRelease ? (
                <a
                  href={task.preRelease.url}
                  className="text-foreground underline underline-offset-2"
                  target="_blank"
                  rel="noreferrer"
                >
                  {t.task.preRelease(task.preRelease.tag)}
                </a>
              ) : null}
              {task.release ? (
                <a
                  href={task.release.url}
                  className="font-medium text-foreground underline underline-offset-2"
                  target="_blank"
                  rel="noreferrer"
                >
                  {t.task.release(task.release.tag)}
                </a>
              ) : null}
              {task.pullRequestUrl ? (
                <a
                  href={task.pullRequestUrl}
                  className="text-foreground underline underline-offset-2"
                  target="_blank"
                  rel="noreferrer"
                >
                  {t.task.pullRequest}
                </a>
              ) : null}
            </div>
          </div>
        )}

        <TaskActions detail={detail} onDone={resource.reload} />
        {detail.questions.length > 0 ? (
          <Surface title={t.task.questions} icon={CircleHelp} count={detail.questions.length}>
            <Rows>
              {detail.questions.map((q) => (
                <Row
                  key={q.id}
                  lead={<RowIcon icon={CircleHelp} tone={q.answer ? 'neutral' : 'warning'} />}
                >
                  <span className={`block whitespace-pre-wrap text-sm ${READABLE}`}>{q.body}</span>
                  <span className={`mt-1 block text-[13px] text-muted-foreground ${READABLE}`}>
                    {q.answer ? t.task.answered(q.answeredBy ?? '', q.answer) : t.task.replyHint}
                  </span>
                </Row>
              ))}
            </Rows>
          </Surface>
        ) : null}

        <div className={split ? (tabbed && !talking ? 'hidden' : 'contents') : undefined}>
          <Conversation
            detail={detail}
            events={transcript.events}
            error={transcript.error}
            focusRun={focusRun}
            tall={split}
            untitled={tabbed}
            onDone={resource.reload}
          />
        </div>
      </div>
      <aside
        aria-label={t.task.tabs.label}
        className={
          tabbed
            ? talking
              ? 'hidden'
              : `${WELL} min-h-0 flex-1`
            : split
              ? 'flex min-h-0 min-w-0 flex-1 flex-col gap-4'
              : STACK
        }
      >
        {beside ? tabs : null}
        <TaskPane id="activity" active={tab} split={split}>
          <WatchPanel watches={detail.watches} onDone={resource.reload} />

          {detail.coordinatorActions.length > 0 ? (
            <Surface title={t.coordinator.sectionTitle} icon={Workflow}>
              <CoordinatorActions actions={detail.coordinatorActions} />
            </Surface>
          ) : null}

          {detail.deliveries.length > 0 ? (
            <Surface title={t.task.deliveries} icon={PackageCheck} count={detail.deliveries.length}>
              <Rows>
                {detail.deliveries.map((d) => (
                  <Row
                    key={d.id}
                    lead={
                      <RowIcon icon={d.kind === 'release' ? Rocket : PackageCheck} tone="success" />
                    }
                  >
                    <span className="block truncate text-sm">
                      <span className="font-medium">
                        {d.kind === 'release' ? t.task.deliveryRelease : t.task.deliveryPreRelease}
                      </span>{' '}
                      <a
                        href={d.url}
                        className="text-foreground underline underline-offset-2"
                        target="_blank"
                        rel="noreferrer"
                      >
                        {d.tag}
                      </a>
                    </span>{' '}
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">
                      {t.task.deliveryMeta(shortSha(d.sha), d.actor, ago(d.at, Date.now(), t.time))}
                    </span>
                  </Row>
                ))}
              </Rows>
            </Surface>
          ) : null}

          <Surface title={t.task.timeline} icon={History}>
            <ol className="divide-y divide-border">
              {detail.timeline.map((event) => (
                <Row
                  key={event.id}
                  title={event.stage}
                  detail={describeEvent(event, t.events) || undefined}
                  trail={ago(event.at, Date.now(), t.time)}
                />
              ))}
            </ol>
          </Surface>
        </TaskPane>
        <TaskPane id="runs" active={tab} split={split}>
          {detail.runs.length > 0 ? (
            <Surface title={t.task.executions} icon={Bot} count={detail.runs.length}>
              <div className="overflow-x-auto">
                <table className={TABLE.table}>
                  <thead className={TABLE.head}>
                    <tr>
                      <th className={TABLE.th}>{t.task.role}</th>
                      <th className={TABLE.th}>{t.task.agent}</th>
                      <th className={TABLE.th}>{t.task.model}</th>
                      <th className={TABLE.th}>{t.task.attempt}</th>
                      <th className={TABLE.th}>{t.task.tokens}</th>
                      <th className={TABLE.th}>{t.task.cost}</th>
                      <th className={TABLE.th}>{t.task.time}</th>
                      <th className={TABLE.th}>{t.task.result}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.runs.map((r) => (
                      <tr key={r.id} className={TABLE.row}>
                        <td className={TABLE.td}>{r.role}</td>
                        <td className={TABLE.td}>
                          <span className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                            <AgentIcon agent={r.harness} size="sm" />
                            {r.harness}
                          </span>
                        </td>
                        <td className={`${TABLE.td} whitespace-nowrap font-medium`}>
                          {modelOf(r, t.task)}
                        </td>
                        <td className={`${TABLE.td} font-mono tabular-nums`}>{r.attempt}</td>
                        <td className={`${TABLE.td} whitespace-nowrap font-mono tabular-nums`}>
                          {r.tokensIn === null && r.tokensOut === null ? (
                            <span className="font-sans text-muted-foreground">
                              {t.task.notReported}
                            </span>
                          ) : (
                            `${r.tokensIn ?? '?'} / ${r.tokensOut ?? '?'}`
                          )}
                        </td>
                        <td className={`${TABLE.td} font-mono tabular-nums`}>
                          {r.costUsd === null ? (
                            <span className="font-sans text-muted-foreground">
                              {t.task.notReported}
                            </span>
                          ) : (
                            money(r.costUsd)
                          )}
                        </td>
                        <td className={`${TABLE.td} whitespace-nowrap font-mono tabular-nums`}>
                          {t.task.seconds((r.durationMs / 1000).toFixed(1))}
                        </td>
                        <td className={`${TABLE.td} whitespace-nowrap`}>
                          {r.quota ? t.task.outOfQuota : r.ok ? t.task.finished : t.task.failed}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Surface>
          ) : null}
        </TaskPane>
        <TaskPane id="evidence" active={tab} split={split}>
          <Surface title={t.task.evidence} icon={FlaskConical}>
            {detail.evidence.length === 0 ? (
              <Quiet>{t.task.noChecks}</Quiet>
            ) : (
              <Rows>
                {detail.evidence.map((e) => (
                  <Row
                    key={e.id}
                    lead={
                      <RowIcon icon={FlaskConical} tone={e.passed ? 'success' : 'destructive'} />
                    }
                    trail={<Pass ok={e.passed} />}
                    below={
                      e.artifacts.length > 0 || e.omitted.length > 0 || e.output ? (
                        <div className="pl-10 text-xs">
                          {e.artifacts.length > 0 || e.omitted.length > 0 ? (
                            <div>
                              <span className="text-muted-foreground">{t.task.artifacts}</span>
                              <ul>
                                {e.artifacts.map((a) => (
                                  <li key={a.id}>
                                    <a
                                      href={`/api/panel/tasks/${detail.task.id}/artifacts/${a.id}`}
                                      download={a.path.split('/').pop()}
                                      className="underline"
                                    >
                                      {a.path}
                                    </a>{' '}
                                    <span className="text-muted-foreground">
                                      {t.task.artifactSize(Math.ceil(a.sizeBytes / 1024))}
                                    </span>
                                  </li>
                                ))}
                                {e.omitted.map((reason) => (
                                  <li key={reason} className="text-muted-foreground">
                                    {t.task.artifactOmitted(reason)}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : null}
                          {e.output ? (
                            <details className="mt-2">
                              <summary className="cursor-pointer text-muted-foreground">
                                {t.task.output}
                              </summary>
                              <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-muted p-2 text-foreground">
                                {e.output}
                              </pre>
                            </details>
                          ) : null}
                        </div>
                      ) : undefined
                    }
                  >
                    <code className="block break-words text-[13px]">{e.command}</code>{' '}
                    <span className="block font-mono text-[11px] text-muted-foreground">
                      {t.task.evidenceMeta(
                        shortSha(e.sha),
                        e.exitCode,
                        (e.durationMs / 1000).toFixed(1),
                      )}
                    </span>
                  </Row>
                ))}
              </Rows>
            )}
            {(detail.testProofs ?? []).length > 0 ? (
              <Rows label={t.task.testProof}>
                {(detail.testProofs ?? []).map((p) => (
                  <Row
                    key={p.id}
                    title={t.task.testProofOutcome[p.outcome]}
                    meta={t.task.testProofMeta(shortSha(p.sha), p.files.length)}
                    detail={p.detail ? <code className="text-xs">{p.detail}</code> : undefined}
                  />
                ))}
              </Rows>
            ) : null}
          </Surface>

          <PlanSection plans={detail.plans} />
        </TaskPane>
        <TaskPane id="reviews" active={tab} split={split}>
          <Surface title={t.task.reviews} icon={Eye}>
            {detail.reviews.length === 0 ? (
              <Quiet>{t.task.notReviewed}</Quiet>
            ) : (
              <Rows>
                {detail.reviews.map((r) => (
                  <Row
                    key={r.id}
                    lead={<AgentIcon agent={r.reviewer} />}
                    title={t.task.reviewLine(r.round, r.verdict)}
                    meta={
                      <>
                        {t.task.reviewedOn(r.reviewer, shortSha(r.sha))}
                        {modelLine(detail.runs, detail.timeline, r, t.task)}
                      </>
                    }
                    detail={<span className={`block ${READABLE}`}>{r.summary}</span>}
                    below={r.findings.length > 0 ? <Findings findings={r.findings} /> : undefined}
                  />
                ))}
              </Rows>
            )}
          </Surface>

          <Surface title={t.task.securityReviews} icon={ShieldCheck}>
            {detail.securityReviews.length === 0 ? (
              <Quiet>{t.task.noSecurityReview}</Quiet>
            ) : (
              <Rows>
                {detail.securityReviews.map((r) => (
                  <Row
                    key={r.id}
                    lead={
                      r.harness ? <AgentIcon agent={r.harness} /> : <RowIcon icon={ShieldCheck} />
                    }
                    title={t.task.securityLine(r.round, r.verdict, r.outcome)}
                    meta={[r.harness, r.model, r.effort, shortSha(r.sha)]
                      .filter(Boolean)
                      .join(' · ')}
                    detail={<span className={`block ${READABLE}`}>{r.summary}</span>}
                    below={r.findings.length > 0 ? <Findings findings={r.findings} /> : undefined}
                  />
                ))}
              </Rows>
            )}
          </Surface>
        </TaskPane>
      </aside>
    </div>
  )
}

/** What a review found, one line each, under its row. */
function Findings({
  findings,
}: {
  findings: { severity: string; file?: string | null; issue: string }[]
}) {
  return (
    <ul className={`list-disc space-y-1 pl-14 text-sm text-foreground ${READABLE}`}>
      {findings.map((f, i) => (
        <li key={i}>
          <strong>{f.severity}</strong>
          {f.file ? <code> {f.file}</code> : null}: {f.issue}
        </li>
      ))}
    </ul>
  )
}

/**
 * The model and effort a pass ran with, said as one line. A model or effort that was not recorded is said
 * to be unknown, never claimed to be the default.
 */
function modelOf(run: RunView, words: { notRecorded: string }): string {
  if (run.model === null && run.effort === null) return words.notRecorded
  const model = run.model ?? words.notRecorded
  const effort = run.effort
  return effort ? `${model} · ${effort}` : model
}

/**
 * The agent pass that made a review: the latest pass of that reviewer, in that attempt, made in the same run
 * before the review was written. A run starts at an intake, and attempts restart at one in each, so a pass of
 * another run or attempt is never the review's: with no such pass the model is left unknown.
 */
function reviewRun(runs: RunView[], timeline: TimelineEvent[], r: ReviewView): RunView | undefined {
  const reviewedAt = Date.parse(r.at)
  const started = timeline
    .filter((e) => e.stage === 'intake' && Date.parse(e.at) <= reviewedAt)
    .map((e) => Date.parse(e.at))
    .sort((x, y) => y - x)[0]
  return runs
    .filter(
      (x) =>
        x.role === 'reviewer' &&
        x.harness === r.reviewer &&
        x.attempt === r.round &&
        Date.parse(x.at) <= reviewedAt &&
        (started === undefined || Date.parse(x.at) >= started),
    )
    .sort((x, y) => Date.parse(y.at) - Date.parse(x.at))[0]
}

function modelLine(
  runs: RunView[],
  timeline: TimelineEvent[],
  r: ReviewView,
  words: { notRecorded: string },
): string {
  const run = reviewRun(runs, timeline, r)
  return ` · ${run ? modelOf(run, words) : words.notRecorded}`
}

import { Alert, Badge, Button, Input, Stepper, type StepperStepData } from '@usetheo/ui'
import {
  CircleAlert,
  CircleCheck,
  FolderGit2,
  Lock,
  type LucideIcon,
  Plug,
  Power,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'

import type {
  DoctorReport,
  RepositoriesView,
  RepositoryView,
  SetupItem,
  SetupReport,
} from '../../shared/panel'
import type { KnowledgeStatus } from '../../shared/knowledge'
import { get, put } from '../lib/api'
import { useCopy } from '../lib/copy'
import { useResource } from '../lib/live'

import { NewJob } from './NewJob'
import { RepositoryDoctor } from './RepositoryDoctor'
import { PageHeader, Quiet, READABLE, Row, RowIcon, Rows, STACK, Surface } from './ui/Surface'

const STEP_IDS = ['connect', 'choose', 'enable'] as const

const STEP_ICON: Record<(typeof STEP_IDS)[number], LucideIcon> = {
  connect: Plug,
  choose: FolderGit2,
  enable: Power,
}

/** Each step is done only when it and every step before it are. */
export const inOrder = (done: boolean[]): boolean[] =>
  done.map((_, i) => done.slice(0, i + 1).every(Boolean))

const TEXT = 'px-4 py-3 text-sm text-muted-foreground'

/** The text and the link of one thing GitHub still needs. */
function Pending({ item }: { item: SetupItem }) {
  const external = item.link?.href.startsWith('http')
  const style = 'text-foreground underline underline-offset-2'
  return (
    <Row
      lead={<RowIcon icon={CircleAlert} tone="warning" />}
      title={item.label}
      detail={item.detail}
      trail={
        item.link && external ? (
          <a href={item.link.href} target="_blank" rel="noreferrer" className={style}>
            {item.link.label}
          </a>
        ) : item.link ? (
          <Link to={item.link.href} className={style}>
            {item.link.label}
          </Link>
        ) : null
      }
    />
  )
}

function Connect({ report }: { report: SetupReport | undefined }) {
  const { t } = useCopy()
  if (!report) return <Quiet>{t.onboarding.connect.loading}</Quiet>
  const pending = report.items.filter((i) => i.status !== 'ok')
  return (
    <>
      <p className={`${TEXT} ${READABLE}`}>{t.onboarding.connect.about}</p>
      {report.ready ? (
        <div className="px-4 pb-4">
          <Alert intent="success" title={t.onboarding.connect.ready} />
        </div>
      ) : (
        <div className="border-t border-border">
          <Rows>
            {pending.map((item) => (
              <Pending key={item.id} item={item} />
            ))}
          </Rows>
        </div>
      )}
    </>
  )
}

function Choose({
  view,
  hidden,
  enabled,
  readOnly,
  onChanged,
}: {
  view: RepositoriesView | undefined
  hidden: string | null
  enabled: RepositoryView | undefined
  readOnly: boolean
  onChanged: () => void
}) {
  const { t } = useCopy()
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string>()
  const [message, setMessage] = useState<string>()
  if (!view) return <Quiet>{t.onboarding.choose.loading}</Quiet>
  if (enabled)
    return (
      <p className="flex items-center gap-2 px-4 py-3 text-sm text-foreground">
        <CircleCheck aria-hidden className="size-4 shrink-0 stroke-success" />
        {t.onboarding.choose.chosen(enabled.fullName)}
      </p>
    )

  const offered = view.repositories.filter(
    (r) => r.reachable && r.fullName.toLowerCase() !== hidden?.toLowerCase(),
  )
  const shown = offered.filter((r) => r.fullName.toLowerCase().includes(query.trim().toLowerCase()))

  async function pick(repo: RepositoryView) {
    setBusy(repo.fullName)
    setMessage(undefined)
    try {
      await put(`/api/panel/repositories/${repo.fullName}`, { enabled: true })
      onChanged()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <>
      <p className={`${TEXT} ${READABLE}`}>{t.onboarding.choose.about}</p>
      {offered.length === 0 ? (
        <Quiet>{t.onboarding.choose.empty}</Quiet>
      ) : (
        <>
          <div className={`px-4 pb-3 ${READABLE}`}>
            <Input
              aria-label={t.onboarding.choose.search}
              placeholder={t.onboarding.choose.search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full"
            />
          </div>
          {shown.length === 0 ? (
            <Quiet>{t.onboarding.choose.none}</Quiet>
          ) : (
            <div className="border-t border-border">
              <Rows label={t.onboarding.steps.choose}>
                {shown.map((repo) => (
                  <Row
                    key={repo.fullName}
                    lead={<RowIcon icon={repo.private ? Lock : FolderGit2} />}
                    title={repo.fullName}
                    trail={
                      <>
                        <Badge variant="default">
                          {repo.private ? t.onboarding.choose.private : t.onboarding.choose.public}
                        </Badge>
                        <Button
                          size="sm"
                          disabled={readOnly || busy !== undefined}
                          onClick={() => void pick(repo)}
                        >
                          {busy === repo.fullName
                            ? t.onboarding.choose.picking
                            : t.onboarding.choose.pick}
                        </Button>
                      </>
                    }
                  />
                ))}
              </Rows>
            </div>
          )}
        </>
      )}
      {message ? (
        <p role="alert" className="px-4 py-3 text-sm text-destructive">
          {message}
        </p>
      ) : null}
    </>
  )
}

/** Three steps from a fresh install to a repository that can take its first job, without a form. */
export function Onboarding() {
  const { t } = useCopy()
  const navigate = useNavigate()
  const setup = useResource<SetupReport>('/api/panel/setup', { everyMs: 30_000, stream: false })
  const repos = useResource<RepositoriesView>('/api/panel/repositories', {
    everyMs: 30_000,
    stream: false,
  })
  // The knowledge repository is never a project. null: no one chosen; undefined: not read yet.
  const [knowledge, setKnowledge] = useState<string | null>()
  const [report, setReport] = useState<DoctorReport>()
  const [viewing, setViewing] = useState<number>()

  useEffect(() => {
    let alive = true
    get<KnowledgeStatus>('/api/panel/knowledge')
      .then((s) => alive && setKnowledge(s.repository))
      .catch(() => alive && setKnowledge(null))
    return () => {
      alive = false
    }
  }, [])

  const chosen = repos.data?.repositories.find(
    (r) => r.enabled && r.fullName.toLowerCase() !== knowledge?.toLowerCase(),
  )
  const blocked = report?.items.some((i) => i.status === 'blocked') ?? true
  const notRead = report?.items.some((i) => i.status === 'unknown') ?? false
  // A step counts only when every step before it does: a step ahead of one still being read is not known.
  const complete = inOrder([
    setup.data?.ready === true,
    chosen !== undefined,
    chosen !== undefined && report?.fullName === chosen.fullName && !blocked,
  ])
  const current = complete.findIndex((c) => !c)
  const active = current === -1 ? STEP_IDS.length - 1 : current
  const shown = viewing !== undefined && complete[viewing] ? viewing : active
  const readOnly = shown !== active

  const steps: StepperStepData[] = STEP_IDS.map((id, i) => ({
    id,
    label: t.onboarding.steps[id],
    status: complete[i] ? 'done' : i === current ? 'active' : 'pending',
  }))

  const step = STEP_IDS[shown]!
  return (
    <>
      <PageHeader title={t.onboarding.title} />
      <div className={STACK}>
        <Surface padded>
          <Stepper
            label={t.onboarding.stepsLabel}
            steps={steps}
            orientation="horizontal"
            stateLabels={t.onboarding.stepState}
          />
          <div className="flex flex-wrap gap-2 empty:hidden">
            {STEP_IDS.map((id, i) =>
              complete[i] && i !== shown ? (
                <Button key={id} size="sm" variant="secondary" onClick={() => setViewing(i)}>
                  {t.onboarding.reopen}: {t.onboarding.steps[id]}
                </Button>
              ) : null,
            )}
          </div>
        </Surface>
        {(setup.error ?? repos.error) ? (
          <p className="text-sm text-destructive">{setup.error ?? repos.error}</p>
        ) : null}
        <Surface title={t.onboarding.steps[step]} icon={STEP_ICON[step]}>
          {shown === 0 ? <Connect report={setup.data} /> : null}
          {shown === 1 ? (
            <Choose
              view={knowledge === undefined ? undefined : repos.data}
              hidden={knowledge ?? null}
              enabled={chosen}
              readOnly={readOnly}
              onChanged={repos.reload}
            />
          ) : null}
          {shown === 2 && chosen ? (
            <>
              <p className={`${TEXT} ${READABLE}`}>{t.onboarding.enable.about(chosen.fullName)}</p>
              {notRead ? <Quiet>{t.onboarding.enable.notRead}</Quiet> : null}
            </>
          ) : null}
        </Surface>
        {shown === 2 && chosen ? (
          <>
            <RepositoryDoctor repo={chosen} onReport={setReport} />
            {complete[2] ? (
              <Surface padded>
                <p className="text-sm text-foreground">{t.onboarding.enable.ready}</p>
                <NewJob
                  repository={chosen.fullName}
                  label={t.onboarding.enable.firstJob}
                  onCreated={() => void navigate('/work')}
                />
              </Surface>
            ) : null}
          </>
        ) : null}
      </div>
    </>
  )
}

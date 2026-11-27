import { Badge, Button } from '@getloopscale/ui'
import {
  CircleCheck,
  CircleHelp,
  CircleX,
  type LucideIcon,
  OctagonX,
  Stethoscope,
  TriangleAlert,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import type {
  ChecksProof,
  DoctorItem,
  DoctorReport,
  ProofKind,
  ProvenCheck,
  RepositoryView,
} from '../../shared/panel'
import { get, post } from '../lib/api'
import { useCopy } from '../lib/copy'
import type { Copy } from '../lib/copy/en'
import { ago } from '../lib/format'
import { useResource } from '../lib/live'

import {
  Quiet,
  READABLE,
  Row,
  RowIcon,
  Rows,
  Surface,
  SurfaceHeading,
  type Tone,
} from './ui/Surface'

const variant = { blocked: 'destructive', warn: 'warning', unknown: 'default' } as const

/** The mark and the colour of a finding: red blocks the repository, amber warns, grey was not read. */
const FINDING: Record<'blocked' | 'warn' | 'unknown', { icon: LucideIcon; tone: Tone }> = {
  blocked: { icon: OctagonX, tone: 'destructive' },
  warn: { icon: TriangleAlert, tone: 'warning' },
  unknown: { icon: CircleHelp, tone: 'neutral' },
}

function Finding({
  item,
  busy,
  onFix,
}: {
  item: DoctorItem
  busy: boolean
  onFix: (id: DoctorItem['id']) => void
}) {
  const { t } = useCopy()
  const status = item.status as 'blocked' | 'warn' | 'unknown'
  // A report stored before the doctor sent codes has only the English sentences.
  const sentence = item.say ? t.doctor.say[item.say.code] : undefined
  const cause = sentence && item.say ? sentence.cause(item.say.values) : item.cause
  const repair = sentence && item.say ? sentence.repair(item.say.values) : item.repair
  return (
    <Row
      lead={<RowIcon icon={FINDING[status].icon} tone={FINDING[status].tone} />}
      trail={<Badge variant={variant[status]}>{t.doctor[status]}</Badge>}
    >
      <span data-item={item.id} className="block text-sm font-medium text-foreground">
        {cause}
      </span>
      {repair ? (
        <span className={`mt-0.5 block text-[13px] text-muted-foreground ${READABLE}`}>
          {t.doctor.repair} {repair}
        </span>
      ) : null}
      {item.link || item.canRepair ? (
        <span className="mt-2 flex gap-2">
          {item.link ? (
            <Button asChild size="sm" variant="secondary">
              <a href={item.link} target="_blank" rel="noreferrer">
                {t.doctor.open}
              </a>
            </Button>
          ) : null}
          {item.canRepair ? (
            <Button size="sm" disabled={busy} onClick={() => onFix(item.id)}>
              {busy ? t.doctor.fixing : t.doctor.fix}
            </Button>
          ) : null}
        </span>
      ) : null}
    </Row>
  )
}

/** What the doctor found in one repository, one row for each thing that is not fine. */
export function RepositoryDoctor({
  repo,
  onReport,
}: {
  repo: RepositoryView
  /** Told every time the report on screen changes, so a page can decide from what the owner sees. */
  onReport?: (report: DoctorReport | undefined) => void
}) {
  const { t, language } = useCopy()
  const base = `/api/panel/repositories/${repo.fullName}/doctor`
  const resource = useResource<DoctorReport>(base, { everyMs: 60_000, stream: false })
  const [fixed, setFixed] = useState<DoctorReport>()
  const [fixing, setFixing] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string>()

  // A newer read from the server replaces what a repair answered with.
  useEffect(() => setFixed(undefined), [resource.data])
  const report = fixed ?? resource.data
  useEffect(() => onReport?.(report), [report, onReport])

  async function fix(id: DoctorItem['id']) {
    setFixing(id)
    setMessage(undefined)
    try {
      setFixed(await post<DoctorReport>(`${base}/repair`, { item: id }))
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setFixing(undefined)
    }
  }

  function again() {
    setLoading(true)
    resource.reload()
  }
  useEffect(() => setLoading(false), [resource.data, resource.error])

  const rows = report?.items.filter((i) => i.status !== 'ok') ?? []
  // A report stored before families existed has none: its items are the operation ones.
  const groups = (['operation', 'codebase'] as const).flatMap((family) => {
    const all = report?.items.filter((i) => (i.family ?? 'operation') === family) ?? []
    return all.length === 0
      ? []
      : [{ family, passing: all.filter((i) => i.status === 'ok').length, total: all.length }]
  })
  const error = message ?? resource.error
  return (
    <Surface
      title={t.doctor.title}
      icon={Stethoscope}
      count={report ? rows.length : undefined}
      action={
        <Button size="sm" variant="secondary" disabled={loading} onClick={again}>
          {loading ? t.doctor.checking : t.doctor.checkAgain}
        </Button>
      }
    >
      {error ? <p className="px-4 py-3 text-sm text-destructive">{error}</p> : null}
      {!report && !error ? <Quiet>{t.doctor.loading}</Quiet> : null}
      {report && rows.length === 0 ? (
        <p className="flex items-center gap-2 px-4 py-3 text-sm text-foreground">
          <CircleCheck aria-hidden className="size-4 shrink-0 stroke-success" />
          {t.doctor.ready(
            language === 'pt-BR'
              ? new Date(report.at).toLocaleString('pt-BR')
              : ago(report.at, Date.now(), t.time),
          )}
        </p>
      ) : null}
      {rows.length > 0 ? (
        <>
          {groups.map((group) => {
            const found = rows.filter((item) => (item.family ?? 'operation') === group.family)
            return (
              <div key={group.family} data-group={group.family}>
                <SurfaceHeading
                  inner
                  as="h3"
                  title={t.doctor.groups[group.family]}
                  lede={t.doctor.passing(group.passing, group.total)}
                />
                {found.length > 0 ? (
                  <Rows>
                    {found.map((item) => (
                      <Finding
                        key={item.id}
                        item={item}
                        busy={fixing === item.id}
                        onFix={(id) => void fix(id)}
                      />
                    ))}
                  </Rows>
                ) : null}
              </div>
            )
          })}
        </>
      ) : null}
    </Surface>
  )
}

/** What a list of a repository a proof is for: where it is, and how the panel speaks of it. */
function proofSide(repo: RepositoryView, kind: ProofKind, t: Copy) {
  if (kind === 'integration') {
    return {
      checks: repo.integrationChecks,
      unproven: repo.unprovenIntegrationChecks,
      query: '?kind=integration',
      body: { kind },
      unprovenLine: t.doctor.integrationUnprovenLine,
      allProven: t.doctor.integrationAllProven,
      prove: t.doctor.proveIntegration,
    }
  }
  return {
    checks: repo.checks ?? [],
    unproven: repo.unprovenChecks,
    query: '',
    body: {},
    unprovenLine: t.doctor.unprovenLine,
    allProven: t.doctor.allProven,
    prove: t.doctor.prove,
  }
}

/** How each check of a proof did, with the tail of what it printed. */
function ProofResults({ results }: { results: ProvenCheck[] }) {
  const { t } = useCopy()
  const label = { passed: t.doctor.passed, failed: t.doctor.failed, too_slow: t.doctor.tooSlow }
  return (
    <ul className="divide-y divide-border border-y border-border">
      {results.map((r) => {
        const passed = r.status === 'passed'
        const Icon = passed ? CircleCheck : CircleX
        return (
          <li key={r.name} className="py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Icon
                aria-hidden
                className={`size-4 shrink-0 ${passed ? 'stroke-success' : 'stroke-destructive'}`}
              />
              <span className="font-medium text-foreground">{r.name}</span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {t.doctor.seconds((r.durationMs / 1000).toFixed(1))}
              </span>
              <Badge variant={passed ? 'success' : 'destructive'} className="ml-auto">
                {label[r.status]}
              </Badge>
            </div>
            {r.output ? (
              <pre className="mt-1 overflow-x-auto font-mono text-xs text-muted-foreground">
                {r.output}
              </pre>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Which saved checks of one kind no proof ran, and the button that proves them in a sandbox. A repository
 * with no integration checks shows nothing for them until a proof of them is asked for.
 */
export function ProveChecks({ repo, kind = 'checks' }: { repo: RepositoryView; kind?: ProofKind }) {
  const { t } = useCopy()
  const side = proofSide(repo, kind, t)
  const base = `/api/panel/repositories/${repo.fullName}/checks/prove`
  const [proof, setProof] = useState<ChecksProof | null>()
  const [message, setMessage] = useState<string>()
  const [asked, setAsked] = useState(false)

  const read = useCallback(async () => {
    try {
      const answer = await get<{ proof: ChecksProof | null }>(`${base}${side.query}`)
      setProof(answer.proof)
      return answer.proof
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
      return null
    }
  }, [base, side.query])

  useEffect(() => {
    if (!asked) return
    let stop = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      const current = await read()
      if (!stop && (!current || current.status === 'proving')) timer = setTimeout(tick, 3_000)
    }
    void tick()
    return () => {
      stop = true
      clearTimeout(timer)
    }
  }, [asked, read])

  async function prove() {
    setMessage(undefined)
    const wanted = side.checks.filter((c) => side.unproven.includes(c.name))
    try {
      await post(base, { checks: wanted, ...side.body })
      setAsked(true)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    }
  }

  if (kind === 'integration' && side.checks.length === 0 && !asked) return null
  const proving = asked && (!proof || proof.status === 'proving')
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-foreground">
          {side.unproven.length > 0 ? side.unprovenLine(side.unproven.join(', ')) : side.allProven}
        </span>
        {side.unproven.length > 0 ? (
          <Button size="sm" variant="secondary" disabled={proving} onClick={() => void prove()}>
            {proving ? t.doctor.proving : side.prove}
          </Button>
        ) : null}
      </div>
      {message ? <p className="text-destructive">{message}</p> : null}
      {proof?.status === 'failed' ? (
        <p className="text-destructive">{t.doctor.proofFailed(proof.error ?? '')}</p>
      ) : null}
      {proof?.setup && proof.setup.length > 0 ? (
        <>
          <p className="text-muted-foreground">{t.doctor.setupLine}</p>
          <ProofResults results={proof.setup} />
        </>
      ) : null}
      {proof && proof.results.length > 0 ? <ProofResults results={proof.results} /> : null}
    </div>
  )
}

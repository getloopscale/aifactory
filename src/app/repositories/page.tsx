import { Alert, Badge, Button, Card, Input, Textarea } from '@usetheo/ui'
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'

import type { RepositoriesView, RepositoryView } from '../../shared/panel'
import { Assist } from '../components/Assist'
import { RecipeCard } from '../components/RecipeCard'
import { ProveChecks, RepositoryDoctor } from '../components/RepositoryDoctor'
import { ReviewPatterns } from '../components/ReviewPatterns'
import { put } from '../lib/api'
import type { Proposal } from '../lib/assist'
import { useCopy } from '../lib/copy'
import { useResource } from '../lib/live'
import {
  leadTimeLimitsProblem,
  MAX_LEAD_TIME_MINUTES,
  MIN_LEAD_TIME_MINUTES,
} from '../../shared/lead-time'
import { MAX_RUN_MINUTES, MIN_RUN_MINUTES } from '../../shared/panel'
import {
  formatChecks,
  formatDomains,
  formatFixes,
  parseChecks,
  parseDomains,
  parseFixes,
} from '../lib/repo-form'

const selectClass =
  'h-9 w-full rounded-lg border border-border bg-card px-2 text-sm text-foreground'

/**
 * A box of commands, one per line, with the assistant above it: how the checks, the integration checks and
 * the fixes are written.
 */
function CommandsBox({
  repository,
  label,
  value,
  onChange,
  rows,
  placeholder,
  context,
  hint,
  onUse,
}: {
  repository: string
  label: string
  value: string
  onChange: (text: string) => void
  rows: number
  placeholder: string
  /** What the assistant should know about this box, when it is not the checks. */
  context?: string
  /** A line under the box saying what its commands are for. */
  hint?: string
  /** What taking the assistant's proposal does; filling the box when absent. */
  onUse?: (proposal: Proposal) => void
}) {
  return (
    <>
      <Assist
        kind="setup"
        text={value}
        repository={repository}
        context={context}
        onUse={onUse ?? ((p) => onChange(p.text))}
      />
      <label className="block">
        <span className="text-foreground">{label}</span>
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={rows}
          placeholder={placeholder}
          className="mt-1 w-full font-mono"
        />
        {hint ? <span className="text-muted-foreground">{hint}</span> : null}
      </label>
    </>
  )
}

function Settings({
  repo,
  agents,
  onSaved,
}: {
  repo: RepositoryView
  agents: string[]
  onSaved: () => void
}) {
  const { t } = useCopy()
  const s = t.repositories.settings
  const [checks, setChecks] = useState(formatChecks(repo.checks))
  const [integration, setIntegration] = useState(formatChecks(repo.integrationChecks))
  const [fixes, setFixes] = useState(formatFixes(repo.fixes))
  const [riskPatterns, setRiskPatterns] = useState(formatFixes(repo.riskPatterns))
  const [domains, setDomains] = useState(formatDomains(repo.egress))
  const [baseBranch, setBaseBranch] = useState(repo.baseBranch ?? '')
  const [releaseBranch, setReleaseBranch] = useState(repo.releaseBranch ?? '')
  const [linearTeam, setLinearTeam] = useState(repo.linearTeamId ?? '')
  const [linearLabel, setLinearLabel] = useState(repo.linearLabel ?? '')
  const [ask, setAsk] = useState(repo.askQuestions)
  const [reviewPulls, setReviewPulls] = useState(repo.reviewExternalPulls)
  const [harness, setHarness] = useState(repo.harness ?? '')
  const [reviewer, setReviewer] = useState(repo.reviewer ?? '')
  const [release, setRelease] = useState(repo.releaseMode ?? '')
  const [image, setImage] = useState<'default' | 'browser'>(repo.sandboxImage ?? 'default')
  const [runLimit, setRunLimit] = useState(repo.runLimitMinutes?.toString() ?? '')
  const [atRisk, setAtRisk] = useState(repo.leadTimeAtRiskMinutes?.toString() ?? '')
  const [overdue, setOverdue] = useState(repo.leadTimeOverdueMinutes?.toString() ?? '')
  const [message, setMessage] = useState<string>()
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    setMessage(undefined)
    try {
      const minutes = runLimit.trim() ? Number(runLimit) : null
      if (
        minutes !== null &&
        (!Number.isInteger(minutes) || minutes < MIN_RUN_MINUTES || minutes > MAX_RUN_MINUTES)
      ) {
        setMessage(t.runLimit.invalid(MIN_RUN_MINUTES, MAX_RUN_MINUTES))
        return
      }
      const limits = {
        atRiskMinutes: atRisk.trim() ? Number(atRisk) : null,
        overdueMinutes: overdue.trim() ? Number(overdue) : null,
      }
      if (leadTimeLimitsProblem(limits)) {
        setMessage(t.leadTimeLimits.invalid(MIN_LEAD_TIME_MINUTES, MAX_LEAD_TIME_MINUTES))
        return
      }
      const parsed = parseChecks(checks)
      await put(`/api/panel/repositories/${repo.fullName}`, {
        checks: parsed.length > 0 ? parsed : null,
        integrationChecks: parseChecks(integration),
        fixes: parseFixes(fixes),
        riskPatterns: parseFixes(riskPatterns),
        egress: parseDomains(domains),
        baseBranch: baseBranch.trim() || null,
        releaseBranch: releaseBranch.trim() || null,
        linearTeamId: linearTeam.trim() || null,
        linearLabel: linearLabel.trim() || null,
        askQuestions: ask,
        reviewExternalPulls: reviewPulls,
        harness: harness || null,
        reviewer: reviewer || null,
        releaseMode: release || null,
        runLimitMinutes: minutes,
        sandboxImage: image,
        leadTimeAtRiskMinutes: limits.atRiskMinutes,
        leadTimeOverdueMinutes: limits.overdueMinutes,
      })
      setMessage(t.repositories.settings.saved)
      onSaved()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 space-y-3 border-t border-border pt-3 text-sm">
      <CommandsBox
        repository={repo.fullName}
        label={s.checks}
        value={checks}
        onChange={setChecks}
        rows={3}
        placeholder={s.checksPlaceholder}
        onUse={(p) => {
          setChecks(p.text)
          if (p.domains) setDomains(formatDomains(p.domains))
        }}
      />
      <CommandsBox
        repository={repo.fullName}
        label={s.integrationChecks}
        value={integration}
        onChange={setIntegration}
        rows={2}
        placeholder={s.integrationChecksPlaceholder}
        context={s.integrationChecksAssistContext}
        hint={s.integrationChecksHelp}
      />
      <CommandsBox
        repository={repo.fullName}
        label={s.fixes}
        value={fixes}
        onChange={setFixes}
        rows={2}
        placeholder={s.fixesPlaceholder}
        context={s.fixesAssistContext}
      />
      <CommandsBox
        repository={repo.fullName}
        label={s.riskPatterns}
        value={riskPatterns}
        onChange={setRiskPatterns}
        rows={3}
        placeholder={s.riskPatternsPlaceholder}
        context={s.riskPatternsAssistContext}
        hint={s.riskPatternsHelp}
      />
      <label className="block">
        <span className="text-foreground">{s.domains}</span>
        <Textarea
          value={domains}
          onChange={(e) => setDomains(e.target.value)}
          rows={2}
          placeholder={s.domainsPlaceholder}
          className="mt-1 w-full font-mono"
        />
      </label>
      <label className="block">
        <span className="text-foreground">{s.baseBranch}</span>
        <Input
          aria-label={s.baseBranch}
          value={baseBranch}
          placeholder={s.defaultPlaceholder}
          onChange={(e) => setBaseBranch(e.target.value)}
          className="mt-1 w-full"
        />
        <span className="text-muted-foreground">
          {s.baseBranchHelp(repo.defaultBranch || s.theDefaultBranch)}
        </span>
      </label>
      <label className="block">
        <span className="text-foreground">{s.releaseBranch}</span>
        <Input
          aria-label={s.releaseBranch}
          value={releaseBranch}
          placeholder={s.releaseBranchDefault(repo.defaultBranch || s.theDefaultBranch)}
          onChange={(e) => setReleaseBranch(e.target.value)}
          className="mt-1 w-full"
        />
        <span className="text-muted-foreground">{s.releaseBranchHelp}</span>
      </label>
      <label className="block">
        <span className="text-foreground">{s.sandboxImage}</span>
        <select
          aria-label={s.sandboxImage}
          value={image}
          onChange={(e) => setImage(e.target.value === 'browser' ? 'browser' : 'default')}
          className="mt-1 w-full rounded border border-border bg-background p-2"
        >
          <option value="default">{s.imageDefault}</option>
          <option value="browser">{s.imageBrowser}</option>
        </select>
        <span className="text-muted-foreground">{s.sandboxImageHelp}</span>
      </label>
      <label className="block">
        <span className="text-foreground">{s.linearTeam}</span>
        <Input
          aria-label={s.linearTeam}
          value={linearTeam}
          onChange={(e) => setLinearTeam(e.target.value)}
          className="mt-1 w-full"
        />
        <span className="text-muted-foreground">{s.linearTeamHelp}</span>
      </label>
      <label className="block">
        <span className="text-foreground">{s.linearLabel}</span>
        <Input
          aria-label={s.linearLabel}
          value={linearLabel}
          placeholder={s.linearLabelDefault}
          onChange={(e) => setLinearLabel(e.target.value)}
          className="mt-1 w-full"
        />
      </label>
      <label className="block">
        <span className="text-foreground">{t.runLimit.label}</span>
        <Input
          aria-label={t.runLimit.label}
          type="number"
          value={runLimit}
          placeholder={t.runLimit.placeholder}
          onChange={(e) => setRunLimit(e.target.value)}
          className="mt-1 w-full"
        />
        <span className="text-muted-foreground">{t.runLimit.help}</span>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-foreground">{t.leadTimeLimits.atRisk}</span>
          <Input
            aria-label={t.leadTimeLimits.atRisk}
            type="number"
            value={atRisk}
            placeholder={t.leadTimeLimits.atRiskPlaceholder}
            onChange={(e) => setAtRisk(e.target.value)}
            className="mt-1 w-full"
          />
        </label>
        <label className="block">
          <span className="text-foreground">{t.leadTimeLimits.overdue}</span>
          <Input
            aria-label={t.leadTimeLimits.overdue}
            type="number"
            value={overdue}
            placeholder={t.leadTimeLimits.overduePlaceholder}
            onChange={(e) => setOverdue(e.target.value)}
            className="mt-1 w-full"
          />
        </label>
        <span className="text-muted-foreground sm:col-span-2">{t.leadTimeLimits.help}</span>
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={ask} onChange={(e) => setAsk(e.target.checked)} />
        <span className="text-foreground">{s.ask}</span>
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={reviewPulls}
          onChange={(e) => setReviewPulls(e.target.checked)}
        />
        <span className="text-foreground">{s.reviewPulls}</span>
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="block">
          <span className="text-foreground">{s.builder}</span>
          <select
            aria-label={s.builder}
            value={harness}
            onChange={(e) => setHarness(e.target.value)}
            className={selectClass}
          >
            <option value="">{s.factoryDefault}</option>
            {agents.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-foreground">{s.reviewer}</span>
          <select
            aria-label={s.reviewer}
            value={reviewer}
            onChange={(e) => setReviewer(e.target.value)}
            className={selectClass}
          >
            <option value="">{s.sameAsBuilder}</option>
            {agents.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-foreground">{s.release}</span>
          <select
            aria-label={s.release}
            value={release}
            onChange={(e) => setRelease(e.target.value)}
            className={selectClass}
          >
            <option value="">{s.factoryDefault}</option>
            <option value="manual">{s.manual}</option>
            <option value="trial">{s.trial}</option>
            <option value="auto">{s.auto}</option>
          </select>
        </label>
      </div>
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={busy} onClick={() => void save()}>
          {s.save}
        </Button>
        {message ? (
          <span role="status" className="text-foreground">
            {message}
          </span>
        ) : null}
      </div>
    </div>
  )
}

function Repo({
  repo,
  agents,
  onChanged,
}: {
  repo: RepositoryView
  agents: string[]
  onChanged: () => void
}) {
  const { t } = useCopy()
  const [message, setMessage] = useState<string>()
  const [busy, setBusy] = useState(false)

  async function toggle() {
    setBusy(true)
    setMessage(undefined)
    try {
      await put(`/api/panel/repositories/${repo.fullName}`, { enabled: !repo.enabled })
      onChanged()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li>
      <Card size="sm" className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          {repo.enabled ? (
            <Link
              to={`/repositories/${repo.fullName}`}
              aria-label={`${t.repositoryDetail.open}: ${repo.fullName}`}
              className="font-medium underline underline-offset-2"
            >
              {repo.fullName}
            </Link>
          ) : (
            <span className="font-medium">{repo.fullName}</span>
          )}
          <Badge variant="default">
            {repo.private ? t.repositories.private : t.repositories.public}
          </Badge>
          {!repo.reachable ? <Badge variant="warning">{t.repositories.noAccess}</Badge> : null}
          {repo.enabled ? <Badge variant="success">{t.repositories.enabled}</Badge> : null}
          <Button
            size="sm"
            variant={repo.enabled ? 'secondary' : 'primary'}
            className="ml-auto"
            disabled={busy}
            onClick={() => void toggle()}
          >
            {repo.enabled ? t.repositories.disable : t.repositories.enable}
          </Button>
        </div>
        {message ? (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {message}
          </p>
        ) : null}
        {repo.enabled ? (
          <>
            <RepositoryDoctor repo={repo} />
            <Settings repo={repo} agents={agents} onSaved={onChanged} />
            <ProveChecks repo={repo} />
            <ProveChecks repo={repo} kind="integration" />
            <ReviewPatterns repository={repo.fullName} />
            <div className="mt-4 border-t border-border pt-3">
              <RecipeCard fullName={repo.fullName} />
            </div>
          </>
        ) : null}
      </Card>
    </li>
  )
}

/** The repositories the GitHub App reaches, and the ones the owner lets the factory work in. */
type Watch = { since: number; accounts: string[]; repositories: number }

/** How long the page keeps asking GitHub after the owner went to install the App. */
const WATCH_MS = 5 * 60_000

/** The button that sends the owner to GitHub to install the App, and the page notices when they are back. */
function InstallButton({ url, onClick }: { url: string; onClick: () => void }) {
  const { t } = useCopy()
  return (
    <Button asChild size="sm" onClick={onClick}>
      <a href={url} target="_blank" rel="noreferrer">
        {t.repositories.installOnGitHub}
      </a>
    </Button>
  )
}

export default function RepositoriesPage() {
  const { t } = useCopy()
  const r = t.repositories
  const [watch, setWatch] = useState<Watch>()
  const [installed, setInstalled] = useState<string>()
  const [params, setParams] = useSearchParams()
  const resource = useResource<RepositoriesView>('/api/panel/repositories', {
    // While the owner is on GitHub installing, the page asks every few seconds instead of every half minute.
    everyMs: watch ? 3_000 : 30_000,
    stream: false,
  })
  const data = resource.data

  // GitHub can send the owner back here with the installation in the address.
  useEffect(() => {
    if (params.get('installation_id')) {
      setInstalled(r.confirmed)
      setParams({}, { replace: true })
      resource.reload()
    }
  }, [params, setParams, resource, r])

  // Once an account or a repository shows up that was not there when the owner left, say so and stop asking.
  useEffect(() => {
    if (!watch || !data) return
    const added = data.installations
      .map((i) => i.account)
      .filter((a) => !watch.accounts.includes(a))
    if (added.length > 0 || data.repositories.length > watch.repositories) {
      setInstalled(
        added.length > 0
          ? r.installedOn(added.join(', '), data.repositories.length)
          : r.inReach(data.repositories.length),
      )
      setWatch(undefined)
    } else if (Date.now() - watch.since > WATCH_MS) {
      setWatch(undefined)
    }
  }, [data, watch, r])

  const startWatching = () => {
    setInstalled(undefined)
    setWatch({
      since: Date.now(),
      accounts: data?.installations.map((i) => i.account) ?? [],
      repositories: data?.repositories.length ?? 0,
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{r.title}</h1>
        <div className="flex items-center gap-2">
          {data?.installUrl ? (
            <InstallButton url={data.installUrl} onClick={startWatching} />
          ) : null}
          <Button size="sm" variant="secondary" onClick={resource.reload}>
            {r.refresh}
          </Button>
        </div>
      </div>
      {watch ? (
        <p role="status" className="text-sm text-muted-foreground">
          {r.waiting}
        </p>
      ) : null}
      {installed ? <Alert intent="success" title={installed} description={r.enableBelow} /> : null}
      {resource.error ? <p className="text-sm text-destructive">{resource.error}</p> : null}
      {data?.error ? (
        <Alert intent="warning" title={r.githubFailed} description={data.error} />
      ) : null}
      {data && data.installations.length > 0 ? (
        <ul aria-label={r.installationsLabel} className="space-y-1 text-sm text-muted-foreground">
          {data.installations.map((i) => (
            <li key={i.account}>
              {r.installation.installedOn} {i.account},{' '}
              {i.selection === 'all' ? r.installation.every : r.installation.chosen}.{' '}
              <a
                href={i.url}
                target="_blank"
                rel="noreferrer"
                className="text-foreground underline underline-offset-2"
              >
                {r.installation.manage}
              </a>{' '}
              {r.installation.signedInAs(i.account)}
            </li>
          ))}
        </ul>
      ) : null}
      {data ? (
        data.repositories.length === 0 ? (
          <Alert
            intent="info"
            title={r.noneTitle}
            description={r.noneDescription}
            action={
              data.installUrl ? (
                <InstallButton url={data.installUrl} onClick={startWatching} />
              ) : undefined
            }
          />
        ) : (
          <ul className="space-y-2">
            {data.repositories.map((repo) => (
              <Repo
                key={repo.fullName}
                repo={repo}
                agents={data.agents}
                onChanged={resource.reload}
              />
            ))}
          </ul>
        )
      ) : (
        <p className="text-sm text-muted-foreground">{r.loading}</p>
      )}
    </div>
  )
}

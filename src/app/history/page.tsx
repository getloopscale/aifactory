import { useState } from 'react'
import { Link } from 'react-router'

import { HISTORY_ROLES, type HistoryReport } from '../../shared/panel'
import { ApiError, get } from '../lib/api'
import { Pane, Workbench } from '../components/ui/Surface'
import { useCopy } from '../lib/copy'
import { ago, itemName, money } from '../lib/format'
import { useResource } from '../lib/live'

type Filters = { q: string; repository: string; role: string; from: string; to: string }
const NONE: Filters = { q: '', repository: '', role: '', from: '', to: '' }

const address = (f: Filters, page: number) => {
  const params = new URLSearchParams({ q: f.q.trim(), page: String(page) })
  if (f.repository.trim()) params.set('repository', f.repository.trim())
  if (f.role) params.set('role', f.role)
  if (f.from) params.set('from', new Date(f.from).toISOString())
  if (f.to) params.set('to', new Date(`${f.to}T23:59:59`).toISOString())
  return `/api/panel/history?${params}`
}

/** Search what the agents did, through Looptrace: one box, a few filters, and the tasks the passes belong to. */
export default function HistoryPage() {
  const { t } = useCopy()
  const status = useResource<{ enabled: boolean; variable: string }>('/api/panel/history/status', {
    stream: false,
  })
  const [form, setForm] = useState<Filters>(NONE)
  const [applied, setApplied] = useState<Filters>()
  const [page, setPage] = useState(1)
  const [report, setReport] = useState<HistoryReport>()
  const [error, setError] = useState<string>()
  const [short, setShort] = useState(false)

  async function run(filters: Filters, at: number) {
    setError(undefined)
    try {
      setReport(await get<HistoryReport>(address(filters, at)))
    } catch (e) {
      setReport(undefined)
      setError(e instanceof ApiError && e.status === 502 ? t.history.unavailable : String(e))
    }
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (form.q.trim().length < 2) return setShort(true)
    setShort(false)
    setApplied(form)
    setPage(1)
    void run(form, 1)
  }

  function go(at: number) {
    setPage(at)
    if (applied) void run(applied, at)
  }

  const off = status.data && !status.data.enabled ? status.data.variable : undefined
  const offVariable = report && !report.enabled ? report.variable : off
  const field = 'rounded-md border border-border bg-background px-2 py-1 text-sm'
  return (
    <Workbench
      header={
        <>
          <h1 className="mb-4 text-xl font-semibold">{t.history.heading}</h1>
          {offVariable ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t.history.off(offVariable)}
            </p>
          ) : (
            <form onSubmit={submit} className="mb-4 space-y-2">
              <div className="flex gap-2">
                <input
                  aria-label={t.history.search}
                  placeholder={t.history.placeholder}
                  value={form.q}
                  maxLength={200}
                  onChange={(e) => setForm({ ...form, q: e.target.value })}
                  className={`${field} flex-1`}
                />
                <button
                  type="submit"
                  className="rounded-md bg-primary px-3 py-1 text-sm text-primary-foreground"
                >
                  {t.history.submit}
                </button>
              </div>
              <div className="flex flex-wrap gap-2 text-sm">
                <input
                  aria-label={t.history.repository}
                  placeholder={t.history.anyRepository}
                  value={form.repository}
                  onChange={(e) => setForm({ ...form, repository: e.target.value })}
                  className={field}
                />
                <select
                  aria-label={t.history.role}
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value })}
                  className={field}
                >
                  <option value="">{t.history.anyRole}</option>
                  {HISTORY_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
                <input
                  type="date"
                  aria-label={t.history.from}
                  value={form.from}
                  onChange={(e) => setForm({ ...form, from: e.target.value })}
                  className={field}
                />
                <input
                  type="date"
                  aria-label={t.history.to}
                  value={form.to}
                  onChange={(e) => setForm({ ...form, to: e.target.value })}
                  className={field}
                />
              </div>
              {short ? <p className="text-sm text-destructive">{t.history.tooShort}</p> : null}
            </form>
          )}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </>
      }
      footer={
        report?.enabled ? (
          <div className="mt-3 flex shrink-0 items-center gap-3 text-sm">
            <button type="button" disabled={page <= 1} onClick={() => go(page - 1)}>
              {t.history.previous}
            </button>
            <span>{t.history.page(page)}</span>
            <button type="button" disabled={!report.hasMore} onClick={() => go(page + 1)}>
              {t.history.next}
            </button>
          </div>
        ) : null
      }
    >
      {report?.enabled ? (
        <Pane>
          {report.results.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.history.empty}</p>
          ) : (
            <ul className="space-y-2">
              {report.results.map((r, i) => (
                <li
                  key={`${r.taskId}-${r.runId ?? i}`}
                  className="rounded-lg border border-border bg-card p-4"
                >
                  <div className="text-sm font-semibold">
                    {r.repository} {itemName(r)} · {r.title}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {[
                      r.role,
                      r.attempt === null ? null : t.history.attempt(r.attempt),
                      r.at ? ago(r.at, Date.now(), t.time) : null,
                      r.costUsd === null ? null : money(r.costUsd),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm">
                    <span className="text-muted-foreground">{t.history.input}: </span>
                    {r.inputPreview}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm">
                    <span className="text-muted-foreground">{t.history.output}: </span>
                    {r.outputPreview}
                  </p>
                  <div className="mt-2 flex gap-4 text-sm">
                    <Link
                      to={`/tasks/${r.taskId}${r.runId === null ? '' : `?pass=${r.runId}`}`}
                      className="underline underline-offset-2"
                    >
                      {t.history.openTask}
                    </Link>
                    {r.traceUrl ? (
                      <a
                        href={r.traceUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="underline underline-offset-2"
                      >
                        {t.history.openTrace}
                      </a>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Pane>
      ) : null}
    </Workbench>
  )
}

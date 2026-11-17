import { Alert, Badge, Button, Input, Textarea } from '@usetheo/ui'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'

import type { PlanItemView, PlanView } from '../../../shared/panel'
import { post, put } from '../../lib/api'
import { Assist } from '../../components/Assist'
import { useCopy } from '../../lib/copy'
import { money } from '../../lib/format'
import { useResource } from '../../lib/live'

type Edit = {
  key: number
  id?: number
  title: string
  body: string
  selected: boolean
  locked: boolean
}

const fromServer = (items: PlanItemView[]): Edit[] =>
  items.map((i) => ({
    key: i.id,
    id: i.id,
    title: i.title,
    body: i.body,
    selected: i.selected,
    locked: i.issueNumber !== null,
  }))

/**
 * One plan: the agent's draft to edit, and the buttons that turn it into issues. The folder is
 * `[planId]` and not `[id]` because two pages with the same dynamic folder name break the build
 * (usetheokit/theokit#1151).
 */
export default function PlanPage() {
  const { t } = useCopy()
  const id = Number(useParams().planId)
  const resource = useResource<PlanView>(`/api/panel/plans/${id}`, { everyMs: 3_000 })
  const plan = resource.data
  const [edits, setEdits] = useState<Edit[]>()
  const [dirty, setDirty] = useState(false)
  const [message, setMessage] = useState<string>()
  const [busy, setBusy] = useState(false)

  // The draft is loaded once the agent is done, and again after a save or a creation, but never over
  // what the owner is typing.
  useEffect(() => {
    if (plan && !dirty) setEdits(fromServer(plan.items))
  }, [plan, dirty])

  if (resource.error) return <p className="text-sm text-destructive">{resource.error}</p>
  if (!plan) return <p className="text-sm text-muted-foreground">{t.plans.loading}</p>

  const change = (key: number, patch: Partial<Edit>) => {
    setDirty(true)
    setEdits((all) => all?.map((e) => (e.key === key ? { ...e, ...patch } : e)))
  }
  const move = (index: number, by: number) => {
    setDirty(true)
    setEdits((all) => {
      if (!all) return all
      const next = [...all]
      const [taken] = next.splice(index, 1)
      next.splice(index + by, 0, taken)
      return next
    })
  }

  async function save() {
    await put(`/api/panel/plans/${id}/items`, {
      items: (edits ?? []).map(({ id: itemId, title, body, selected }) => ({
        id: itemId,
        title,
        body,
        selected,
      })),
    })
    setDirty(false)
  }

  async function act(work: () => Promise<string | undefined>) {
    setBusy(true)
    setMessage(undefined)
    try {
      setMessage(await work())
      resource.reload()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const createIssues = (start: boolean) =>
    act(async () => {
      if (dirty) await save()
      const result = await post<{ created: number[]; failure: string | null }>(
        `/api/panel/plans/${id}/issues`,
        { start },
      )
      return result.failure
        ? t.plans.refused(result.created.length, result.failure)
        : t.plans.created(result.created.length, start)
    })

  const waiting = (edits ?? []).filter((e) => e.selected && !e.locked).length

  return (
    <div className="space-y-5">
      <div>
        <Link to="/plans" className="text-sm text-muted-foreground hover:text-foreground">
          {t.plans.back}
        </Link>
        <h1 className="mt-1 text-xl font-semibold">{plan.goal}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <span>{plan.repository}</span>
          <span>{money(plan.costUsd)}</span>
          <Badge
            variant={
              plan.status === 'failed'
                ? 'destructive'
                : plan.status === 'planning'
                  ? 'primary'
                  : 'success'
            }
          >
            {t.plans.status[plan.status]}
          </Badge>
        </div>
      </div>

      {plan.status === 'planning' ? (
        <Alert intent="info" title={t.plans.reading} description={t.plans.readingText} />
      ) : null}
      {plan.status === 'failed' ? (
        <Alert
          intent="destructive"
          title={t.plans.failedTitle}
          description={plan.error ?? t.plans.noReason}
          action={
            <Link to="/plans" className="text-sm underline underline-offset-2">
              {t.plans.tryAgain}
            </Link>
          }
        />
      ) : null}
      {plan.summary ? <p className="text-sm text-foreground">{plan.summary}</p> : null}

      {edits && edits.length > 0 ? (
        <ol aria-label={t.plans.issues} className="space-y-3">
          {edits.map((e, index) => {
            const item = plan.items.find((i) => i.id === e.id)
            return (
              <li
                key={e.key}
                className="space-y-2 rounded-lg border border-border bg-card p-3 text-sm"
              >
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    aria-label={t.plans.include(index + 1)}
                    checked={e.selected}
                    disabled={e.locked}
                    onChange={(ev) => change(e.key, { selected: ev.target.checked })}
                  />
                  <Input
                    aria-label={t.plans.titleOf(index + 1)}
                    value={e.title}
                    disabled={e.locked}
                    onChange={(ev) => change(e.key, { title: ev.target.value })}
                    className="flex-1"
                  />
                  {!e.locked ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t.plans.moveUp(index + 1)}
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                      >
                        ↑
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t.plans.moveDown(index + 1)}
                        disabled={index === edits.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        ↓
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t.plans.removeLabel(index + 1)}
                        onClick={() => {
                          setDirty(true)
                          setEdits((all) => all?.filter((x) => x.key !== e.key))
                        }}
                      >
                        {t.plans.remove}
                      </Button>
                    </>
                  ) : null}
                </div>
                <Textarea
                  aria-label={t.plans.descriptionOf(index + 1)}
                  value={e.body}
                  disabled={e.locked}
                  rows={5}
                  onChange={(ev) => change(e.key, { body: ev.target.value })}
                  className="w-full"
                />
                {!e.locked ? (
                  <Assist
                    kind="issue"
                    text={e.body}
                    repository={plan.repository}
                    context={`Title: ${e.title}`}
                    onUse={(p) =>
                      change(e.key, { body: p.text, ...(p.title ? { title: p.title } : {}) })
                    }
                  />
                ) : null}
                {item?.issueNumber ? (
                  <div className="flex items-center gap-3">
                    <a
                      href={item.issueUrl ?? '#'}
                      target="_blank"
                      rel="noreferrer"
                      className="text-foreground underline underline-offset-2"
                    >
                      {t.plans.issueLink(item.issueNumber)}
                    </a>
                    {item.started ? (
                      <Badge variant="success">{t.plans.started}</Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await post(`/api/panel/plans/${id}/items/${item.id}/start`)
                            return t.plans.startedIssue(item.issueNumber ?? 0)
                          })
                        }
                      >
                        {t.plans.startThis}
                      </Button>
                    )}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ol>
      ) : null}

      {plan.status === 'ready' || plan.status === 'created' ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => void act(async () => (await save(), t.plans.saved))}
          >
            {t.plans.saveChanges}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || waiting === 0}
            onClick={() => void createIssues(false)}
          >
            {t.plans.createIssues}
          </Button>
          <Button
            size="sm"
            disabled={busy || waiting === 0}
            onClick={() => void createIssues(true)}
          >
            {t.plans.createAndStart}
          </Button>
          <span className="text-xs text-muted-foreground">{t.plans.toCreate(waiting)}</span>
        </div>
      ) : null}
      {message ? (
        <p role="status" className="text-sm text-foreground">
          {message}
        </p>
      ) : null}
    </div>
  )
}

import { Button } from '@getloopscale/ui'
import { SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'

import {
  securityEffort,
  type AgentRole,
  type AgentSettings,
  type RoleModels,
} from '../../../shared/panel'
import { put } from '../../lib/api'
import { useCopy } from '../../lib/copy'
import { AgentIcon } from '../floor/AgentIcon'
import { READABLE, Surface } from '../ui/Surface'

const SAME = ''

const select = 'h-9 min-w-52 rounded-lg border border-border bg-card px-2 text-sm text-foreground'
const caption = 'mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground'

/**
 * The choice of which coding agent does a role, with which model and how much effort. It is saved in the
 * panel and applied to the next run with no restart. An agent that cannot start (its credential is missing)
 * is listed but cannot be picked, with what is missing, because a choice that breaks every run is worse than
 * none. The models and the effort levels are the ones of the agent chosen, and change with it, because a
 * model of one agent means nothing to the other. Planner and reviewer can follow the builder.
 */
export function EngineChooser({
  role,
  settings,
  reported,
  onSaved,
}: {
  role: AgentRole
  settings: AgentSettings
  /** The model each agent last reported per role; the agent's default is named from it. */
  reported?: RoleModels
  onSaved: () => void
}) {
  const { t } = useCopy()
  const ROLE_LABEL = t.engine.roleLabel
  const ROLE_NAME = t.engine.roleName
  const stored = settings.chosen[role]
  const current = role === 'builder' ? settings.effective.builder : (stored ?? SAME)
  const currentModel = settings.chosenModel[role] ?? SAME
  const currentEffort = settings.chosenEffort[role] ?? SAME
  const [value, setValue] = useState(current)
  const [model, setModel] = useState(currentModel)
  const [effort, setEffort] = useState(currentEffort)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string }>()
  const pinned = role === 'security'
  const changed =
    value !== current || model !== currentModel || (!pinned && effort !== currentEffort)
  const unavailable = settings.options.filter((o) => !o.ready)
  const own = settings.repositoriesWithOwn.filter((r) =>
    role === 'reviewer' ? r.reviewer : r.builder,
  )

  // The agent this role will use, which is the one whose models and effort levels are on offer.
  const engine = value === SAME ? settings.effective.builder : value
  const offered = settings.engines[engine] ?? { models: [], efforts: [] }
  const picked = offered.models.find((m) => m.id === model)
  const levels = picked?.efforts ?? offered.efforts
  const reportedModel = reported?.[role]?.[engine]

  function chooseEngine(next: string) {
    setValue(next)
    // A model and an effort belong to one agent: they do not carry over to another.
    setModel(SAME)
    setEffort(SAME)
  }

  function chooseModel(next: string) {
    setModel(next)
    const nextLevels = offered.models.find((m) => m.id === next)?.efforts ?? offered.efforts
    if (!nextLevels.includes(effort)) setEffort(SAME)
  }

  async function save() {
    setBusy(true)
    setMessage(undefined)
    try {
      await put('/api/panel/agents/settings', {
        ...(value === current ? {} : { [role]: value === SAME ? null : value }),
        models: { [role]: model === SAME ? null : model },
        // The security role's effort is pinned: it is never sent, and the server refuses a lower one.
        ...(pinned ? {} : { efforts: { [role]: effort === SAME ? null : effort } }),
      })
      setMessage({
        ok: true,
        text: t.engine.saved,
      })
      onSaved()
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Surface title={t.engine.choice(ROLE_LABEL[role])} icon={SlidersHorizontal} padded>
      <div className="flex flex-wrap items-end gap-3">
        <span className="flex h-9 items-center">
          <AgentIcon agent={engine} />
        </span>
        <label className="block">
          <span className={caption}>{ROLE_LABEL[role]}</span>
          <select
            aria-label={ROLE_LABEL[role]}
            className={select}
            value={value}
            onChange={(e) => chooseEngine(e.target.value)}
          >
            {role === 'builder' ? null : (
              <option value={SAME}>{t.engine.sameAsBuilder(settings.effective.builder)}</option>
            )}
            {settings.options.map((o) => (
              <option key={o.id} value={o.id} disabled={!o.ready}>
                {o.id}
                {o.ready ? '' : t.engine.unavailable}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={caption}>{t.engine.model}</span>
          <select
            aria-label={t.engine.modelOf(ROLE_NAME[role])}
            className={select}
            value={model}
            onChange={(e) => chooseModel(e.target.value)}
          >
            <option value={SAME}>
              {reportedModel
                ? t.engine.agentDefaultToday(reportedModel)
                : t.engine.agentDefaultUnknown}
            </option>
            {offered.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        {pinned ? (
          <div>
            <span className={caption}>{t.engine.effort}</span>
            <p aria-label={t.engine.effortOf(ROLE_NAME[role])} className="h-9 text-sm leading-9">
              {securityEffort(levels)
                ? t.engine.pinnedEffort(securityEffort(levels) as string)
                : t.engine.pinnedUnknown}
            </p>
          </div>
        ) : (
          <label className="block">
            <span className={caption}>{t.engine.effort}</span>
            <select
              aria-label={t.engine.effortOf(ROLE_NAME[role])}
              className={`${select} min-w-36`}
              value={effort}
              onChange={(e) => setEffort(e.target.value)}
            >
              <option value={SAME}>{t.engine.default}</option>
              {levels.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button size="sm" disabled={!changed || busy} onClick={() => void save()}>
          {t.engine.save}
        </Button>
      </div>

      {picked?.note ? (
        <p className={`text-xs text-muted-foreground ${READABLE}`}>{picked.note}</p>
      ) : null}
      {offered.models.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t.engine.noModelList(engine)}</p>
      ) : null}

      {unavailable.length > 0 ? (
        <ul className="space-y-1.5 text-xs text-muted-foreground">
          {unavailable.map((o) => (
            <li key={o.id} className="flex items-center gap-2">
              <AgentIcon agent={o.id} size="sm" />
              <span>
                <span className="font-mono">{o.id}</span>
                {t.engine.cannotChoose}
                {o.problem}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {own.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t.engine.ownAgent} {own.map((r) => r.repository).join(', ')}.{' '}
          <Link to="/repositories" className="underline underline-offset-2">
            {t.engine.changeInRepositories}
          </Link>
        </p>
      ) : null}

      {message ? (
        <p
          role={message.ok ? 'status' : 'alert'}
          className={`text-sm ${message.ok ? 'text-foreground' : 'text-destructive'}`}
        >
          {message.text}
        </p>
      ) : null}
    </Surface>
  )
}

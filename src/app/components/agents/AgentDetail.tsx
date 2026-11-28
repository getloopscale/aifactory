import { Badge } from '@getloopscale/ui'
import {
  Box,
  Eye,
  FileCode,
  Hand,
  Layers,
  type LucideIcon,
  ScrollText,
  UserRound,
  Wrench,
} from 'lucide-react'
import { useState } from 'react'

import {
  DEFAULT_MODEL_WORD,
  FIXED_EFFORT_WORD,
  securityEffort,
  type AgentEntry,
  type AgentPrompt,
  type AgentRole,
  type AgentSettings,
  type RoleModels,
} from '../../../shared/panel'

import { useCopy } from '../../lib/copy'
import { READABLE, Row, RowIcon, Rows, STACK, Surface, type Tone } from '../ui/Surface'

import { agentIcon } from './AgentList'
import { EngineChooser } from './EngineChooser'
import { PromptBlock } from './PromptBlock'

const ROLES = [
  'builder',
  'planner',
  'reviewer',
  'merger',
  'security',
  'lens',
] as const satisfies readonly AgentRole[]
const roleOf = (id: string): AgentRole | undefined => ROLES.find((r) => r === id)

const TONE = { reads: 'default', asks: 'warning', sandbox: 'primary' } as const

/** The mark of what a tool may do: only read, change something once the owner agrees, or act in the sandbox. */
const EFFECT: Record<keyof typeof TONE, { icon: LucideIcon; tone: Tone }> = {
  reads: { icon: Eye, tone: 'neutral' },
  asks: { icon: Hand, tone: 'warning' },
  sandbox: { icon: Box, tone: 'neutral' },
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm text-foreground/90">{children}</dd>
    </div>
  )
}

/** Everything about one agent: what it does, what runs it, what it may call, and what it is told. */
export function AgentDetail({
  agent,
  shared,
  settings,
  query,
  reported,
  onSettingsSaved,
}: {
  agent: AgentEntry
  shared: AgentPrompt[]
  settings: AgentSettings
  query: string
  reported?: RoleModels
  onSettingsSaved: () => void
}) {
  const { t } = useCopy()
  const role = roleOf(agent.id)
  const [chosen, setChosen] = useState(0)
  const index = Math.min(chosen, agent.prompts.length - 1)
  const prompt = agent.prompts[index]
  let engineText = agent.engine.value
  if (role) {
    // The catalog writes the model and the effort in a fixed word where the page can say more than it knows.
    const engine = settings.effective[role]
    const model = settings.chosenModel[role]
    const offered = settings.engines[engine]
    const levels = offered?.models.find((m) => m.id === model)?.efforts ?? offered?.efforts ?? []
    engineText = engineText
      .replace(DEFAULT_MODEL_WORD, () => t.engine.summaryDefault(reported?.[role]?.[engine]))
      .replace(FIXED_EFFORT_WORD, () => t.engine.summaryEffort(securityEffort(levels)))
  }
  const context = shared.filter((s) => agent.shared.includes(s.id))

  return (
    <article aria-label={agent.name} className={STACK}>
      <Surface
        title={agent.name}
        icon={agentIcon(agent.id)}
        action={
          <Badge variant={agent.runsIn === 'sandbox' ? 'primary' : 'accent'}>
            {agent.runsIn === 'sandbox' ? t.agents.runsInSandbox : t.agents.runsOnServer}
          </Badge>
        }
      >
        <p className={`px-4 py-3 text-sm text-foreground/90 ${READABLE}`}>{agent.role}</p>
        <dl className="grid gap-5 border-t border-border p-4 md:grid-cols-2">
          <Fact label={t.agents.when}>{agent.when}</Fact>
          <Fact label={t.agents.engine}>
            <span className="font-mono text-[13px]">{engineText}</span>
            <span className="mt-1 block text-xs text-muted-foreground">
              {t.agents.howToChange(agent.engine.change)}
            </span>
          </Fact>
        </dl>
      </Surface>

      {agent.persona ? (
        <Surface
          title={`${t.agents.persona}: ${agent.persona.name}`}
          label={t.agents.persona}
          icon={UserRound}
          padded
        >
          <div className={`space-y-2 text-sm ${READABLE}`}>
            <p>{agent.persona.job}</p>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              {t.agents.never}
            </p>
            <ul className="list-disc pl-5">
              {agent.persona.never.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
            <p className="text-muted-foreground">{agent.persona.voice}</p>
          </div>
        </Surface>
      ) : null}

      {role ? (
        <EngineChooser
          key={`${role}:${settings.chosen[role]}:${settings.effective[role]}:${settings.chosenModel[role]}:${settings.chosenEffort[role]}`}
          role={role}
          settings={settings}
          reported={reported}
          onSaved={onSettingsSaved}
        />
      ) : null}

      <Surface title={t.agents.canDo} icon={Wrench} count={agent.tools.length}>
        <Rows>
          {agent.tools.map((tool) => (
            <Row
              key={tool.name}
              lead={<RowIcon icon={EFFECT[tool.effect].icon} tone={EFFECT[tool.effect].tone} />}
              title={<code className="font-mono text-[13px]">{tool.name}</code>}
              detail={tool.description}
              trail={
                <Badge variant={TONE[tool.effect]} className="shrink-0">
                  {t.agents.effects[tool.effect]}
                </Badge>
              }
            />
          ))}
        </Rows>
      </Surface>

      <Surface
        title={t.agents.instructions}
        icon={ScrollText}
        count={agent.prompts.length > 1 ? agent.prompts.length : undefined}
      >
        {agent.prompts.length > 1 ? (
          <div
            role="tablist"
            aria-label={t.agents.instructionsOf}
            className="flex flex-wrap gap-1.5 border-b border-border px-4 py-2.5"
          >
            {agent.prompts.map((p, i) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={i === index}
                onClick={() => setChosen(i)}
                className={`rounded-full px-3 py-1 text-[13px] transition-colors ${i === index ? 'bg-muted font-medium text-foreground' : 'border border-border text-foreground/75 hover:bg-muted/60'}`}
              >
                {p.title}
              </button>
            ))}
          </div>
        ) : null}
        <PromptBlock key={`${agent.id}:${prompt.id}`} prompt={prompt} query={query} />
      </Surface>

      {context.map((c) => (
        // A block that folds, so it is a details element with the look of a Surface.
        <details
          key={c.id}
          className="w-full overflow-hidden rounded-xl border border-border bg-card"
        >
          <summary className="flex min-h-10 cursor-pointer items-center gap-2 px-4 py-2 text-sm font-semibold">
            <Layers aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            {t.agents.alsoReceives} {c.title}
            <span className="ml-1 min-w-0 truncate text-xs font-normal text-muted-foreground">
              {c.when}
            </span>
          </summary>
          <div className="border-t border-border">
            <PromptBlock prompt={c} query={query} />
          </div>
        </details>
      ))}

      <Surface title={t.agents.whereInCode} icon={FileCode} count={agent.source.length}>
        <Rows>
          {agent.source.map((file) => (
            <Row key={file} lead={<RowIcon icon={FileCode} />}>
              <code className="block truncate font-mono text-xs text-muted-foreground">{file}</code>
            </Row>
          ))}
        </Rows>
        <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
          {t.agents.readOnly}
        </p>
      </Surface>
    </article>
  )
}

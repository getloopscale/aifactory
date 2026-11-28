import { Button, Input } from '@getloopscale/ui'
import { useAgent } from '@getloopscale/loopzero/client'
import { useEffect, useState } from 'react'

import type { AssistProviderRefusal, HealthReport } from '../../shared/panel'
import { get } from '../lib/api'
import {
  agentFor,
  assistProblem,
  buildMessage,
  proposalOf,
  type AssistKind,
  type Proposal,
} from '../lib/assist'
import { useCopy } from '../lib/copy'

/** A text box with nothing in it is only worth helping with when the assistant can look at the project. */
const NEEDS_WORDS: Record<AssistKind, boolean> = {
  goal: true,
  job: true,
  issue: true,
  changes: true,
  resolution: true,
  pr_title: true,
  pr_description: true,
  setup: false,
}

/**
 * What the factory recorded of the assistants' provider, read once the assistant failed: the framework sends the
 * page only "An error occurred." for a provider's refusal. `undefined` while it is being read, `null` for nothing.
 */
function useProviderRefusal(failed: Error | undefined): AssistProviderRefusal | null | undefined {
  const [refusal, setRefusal] = useState<AssistProviderRefusal | null>()
  useEffect(() => {
    setRefusal(undefined)
    if (!failed) return
    let live = true
    get<HealthReport>('/api/panel/health').then(
      (report) => live && setRefusal(report.assistProvider ?? null),
      () => live && setRefusal(null),
    )
    return () => {
      live = false
    }
  }, [failed])
  return refusal
}

/**
 * The assistant under a text box. The owner says what they want in their own words, the assistant
 * writes what the factory needs, and nothing changes until the owner presses "Use this". It is the same
 * under every box, so a person who is not a programmer learns it once.
 */
export function Assist({
  kind,
  text,
  repository,
  context,
  onUse,
}: {
  kind: AssistKind
  /** What the owner has typed so far. */
  text: string
  repository?: string
  /** What the assistant should know about where the text goes (for example the pull request). */
  context?: string
  onUse: (proposal: Proposal) => void
}) {
  const { t } = useCopy()
  const agent = useAgent<{ message: string }>(agentFor(kind), {
    headers: { 'x-loopzero-action': '1' },
  })
  const [instruction, setInstruction] = useState('')
  const proposal = proposalOf(agent.thread)
  const working = agent.status === 'streaming'
  const refusal = useProviderRefusal(agent.error)
  // The cause is told once it is known, so the owner never reads the framework's "An error occurred." first.
  const problem =
    refusal === undefined ? undefined : assistProblem(agent.error, t.assistProblems, refusal)
  const ready = !NEEDS_WORDS[kind] || text.trim().length >= 3

  const ask = (change?: string) =>
    agent.send({ message: buildMessage({ kind, repository, context, text, instruction: change }) })

  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={working || !ready}
          onClick={() => {
            agent.reset()
            ask()
          }}
        >
          {t.assist.label[kind]}
        </Button>
        {working ? (
          <span role="status" className="text-muted-foreground">
            {t.assist.working}
          </span>
        ) : null}
        {!working && !proposal && !problem && NEEDS_WORDS[kind] && !ready ? (
          <span className="text-muted-foreground">{t.assist.needsWords}</span>
        ) : null}
      </div>
      {problem && !working ? (
        <p role="alert" className="text-destructive">
          {problem}
        </p>
      ) : null}
      {proposal && !working ? (
        <section
          aria-label={t.assist.suggestion}
          className="space-y-2 rounded-xl border border-border bg-muted/40 px-4 py-3"
        >
          {proposal.title ? <p className="font-medium text-foreground">{proposal.title}</p> : null}
          <p className="whitespace-pre-wrap text-foreground">{proposal.text}</p>
          {proposal.domains && proposal.domains.length > 0 ? (
            <p className="text-muted-foreground">
              {t.assist.extraDomains(proposal.domains.join(', '))}
            </p>
          ) : null}
          {proposal.notes ? <p className="text-muted-foreground">{proposal.notes}</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => {
                onUse(proposal)
                agent.reset()
                setInstruction('')
              }}
            >
              {t.assist.use}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                agent.reset()
                setInstruction('')
              }}
            >
              {t.assist.dismiss}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Input
              aria-label={t.assist.askChange}
              value={instruction}
              placeholder={t.assist.changePlaceholder}
              onChange={(e) => setInstruction(e.target.value)}
              className="flex-1"
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={instruction.trim() === ''}
              onClick={() => {
                ask(instruction.trim())
                setInstruction('')
              }}
            >
              {t.assist.change}
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  )
}

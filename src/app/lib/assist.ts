import type { UIMessage } from '@getloopscale/loopzero/client'

import type { AssistProviderRefusal } from '../../shared/panel'

import { en, type Copy } from './copy/en'
import type { Language } from './copy'

export type AssistKind =
  'goal' | 'job' | 'issue' | 'changes' | 'resolution' | 'pr_title' | 'pr_description' | 'setup'

/** What the assistant hands back through its `propose` tool, which is what the owner can accept. */
export type Proposal = {
  title?: string
  text: string
  domains?: string[]
  notes: string
}

/** The agent each kind talks to: only the one that sets a repository up may read it. */
export const agentFor = (kind: AssistKind) =>
  kind === 'setup' ? '/api/agents/assist-setup' : '/api/agents/assist'

/**
 * The message the assistant gets: a header that says what the text is for, the language of the page and where,
 * then what the owner wrote. The header and the context are English whatever the page's language, so the
 * language rides along for the assistant to fall back on when the owner's words are too few to tell (#770).
 * An instruction to change a suggestion rides on the same header, so the assistant stays on the
 * same kind of text.
 */
export function buildMessage(input: {
  kind: AssistKind
  language: Language
  repository?: string
  context?: string
  text: string
  instruction?: string
}): string {
  const header = [
    `kind: ${input.kind}`,
    `language: ${input.language}`,
    ...(input.repository ? [`repository: ${input.repository}`] : []),
    ...(input.context ? [`context: ${input.context}`] : []),
  ].join('\n')
  const wrote = input.instruction
    ? `${input.text}\n\nThe owner then asked for a change to your suggestion: ${input.instruction}`
    : input.text
  return `${header}\n\nThe owner wrote:\n${wrote}`
}

/** The newest suggestion in the conversation, once its text is complete. */
export function proposalOf(thread: UIMessage[]): Proposal | undefined {
  for (const message of [...thread].reverse()) {
    if (message.role !== 'assistant') continue
    for (const part of [...message.parts].reverse()) {
      // The framework hands a tool call over as a `dynamic-tool` part named by `toolName`; a typed
      // `tool-propose` part is accepted too, so a change of that does not leave the owner with nothing.
      const isPropose =
        part.type === 'tool-propose' ||
        (part.type === 'dynamic-tool' && part.toolName === 'propose')
      if (!isPropose || part.state === 'input-streaming') continue
      const input = part.input as Partial<Proposal> | undefined
      if (typeof input?.text !== 'string' || input.text.trim() === '') continue
      return {
        text: input.text,
        notes: typeof input.notes === 'string' ? input.notes : '',
        ...(typeof input.title === 'string' && input.title.trim() !== ''
          ? { title: input.title }
          : {}),
        ...(Array.isArray(input.domains)
          ? { domains: input.domains.filter((d): d is string => typeof d === 'string') }
          : {}),
      }
    }
  }
  return undefined
}

/** A provider's name as the owner knows it (`anthropic` is Anthropic). */
export const providerName = (provider: string) =>
  provider === 'anthropic' ? 'Anthropic' : provider === 'openai' ? 'OpenAI' : provider

/**
 * Why the assistant could not answer, in words an owner can act on. The framework sends the page only "An error
 * occurred." for a provider's refusal, so the cause comes from what the factory recorded of it (`refusal`, from
 * the health report); with none, the error is read as it came.
 */
export function assistProblem(
  error: Error | undefined,
  t: Copy['assistProblems'] = en.assistProblems,
  refusal?: AssistProviderRefusal | null,
): string | undefined {
  if (!error) return undefined
  if (refusal?.reason === 'credit') return t.creditRefused(providerName(refusal.provider))
  const message = error.message
  if (/\b(401|403)\b|forbidden|policy/i.test(message)) return t.signIn
  // "Your credit balance is too low" is Anthropic's wording.
  if (/credit balance|billing/i.test(message)) return t.creditRefused('Anthropic')
  if (/api[-_ ]?key|authentication|unauthor|credit/i.test(message)) return t.noCredit
  return t.couldNot(message)
}

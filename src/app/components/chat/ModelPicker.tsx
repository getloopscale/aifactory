import { DropdownMenu } from '@getloopscale/ui'
import { Check, ChevronDown } from 'lucide-react'

import type { ChatModel, ChatModels } from '../../../shared/panel'
import { MODELS } from '../../lib/chat'
import { useCopy } from '../../lib/copy'
import { useResource } from '../../lib/live'

import { TOOL } from './MessageBox'

/** A model without its vendor, which is what fits on a button: `google/gemini-2.5-flash` is `gemini-2.5-flash`. */
export const shortModel = (model: string) => model.slice(model.lastIndexOf('/') + 1)

/** Which agent answers, as a small menu in the composer. The button names the model of the choice made, without its vendor, and
 * each choice names its model in full, once the server said them. */
export function ModelPicker({
  model,
  onChange,
  use = 'chat',
}: {
  model: ChatModel
  onChange: (model: ChatModel) => void
  /** Whose models to name: the chat's, or those of the guides of the pages. */
  use?: keyof ChatModels
}) {
  const { t } = useCopy()
  // The models change only with a restart of the server, so this is read once and seldom again.
  const { data } = useResource<ChatModels>('/api/panel/chat/models', {
    stream: false,
    everyMs: 600_000,
  })
  const behind = data?.[use]
  const current = MODELS.find((m) => m.id === model) ?? MODELS[0]
  const said = behind?.[current.id]
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={t.chat.model}
          title={said ? `${current.name} · ${said}` : current.name}
          className={`${TOOL} min-w-0 px-2`}
        >
          <span className={`truncate ${said ? 'font-mono' : ''}`}>
            {said ? shortModel(said) : current.name}
          </span>
          <ChevronDown className="size-3.5 shrink-0" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" side="top" sideOffset={6} className="min-w-64">
        {MODELS.map((m) => (
          <DropdownMenu.Item key={m.id} onSelect={() => onChange(m.id)} className="items-start">
            <span className="flex-1">
              <span className="flex items-baseline gap-2 text-[14px]">
                {m.name}
                {behind ? (
                  <span className="font-mono text-xs text-foreground/60">{behind[m.id]}</span>
                ) : null}
              </span>
              <span className="block text-xs text-foreground/50">{t.chat.blurbs[m.id]}</span>
            </span>
            {m.id === model ? <Check className="ml-3 mt-0.5 size-4" /> : null}
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

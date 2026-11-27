import type { ChatModels } from '../../shared/panel'
import { guideCodexModel, guideModel } from '../factory/guides'
import { chatCodexModel, chatModel } from '../factory/models'

/** A model as the owner reads it: without the provider the framework routes it by (`openrouter/`, `openai-chatgpt/`). */
export const modelName = (id: string) => id.replace(/^(openrouter|openai-chatgpt)\//, '')

/** The model that answers for each choice of the picker, read from the same settings the agents are built with. */
export const chatModels = (env: NodeJS.ProcessEnv = process.env): ChatModels => ({
  chat: { openrouter: modelName(chatModel(env)), codex: modelName(chatCodexModel(env)) },
  guide: { openrouter: modelName(guideModel(env)), codex: modelName(guideCodexModel(env)) },
})

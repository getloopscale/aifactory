import { evaluateRoutePolicy, type RoutePolicy } from '@getloopscale/loopzero/server/define'
import { describe, expect, it } from 'vitest'

import { GET } from '../routes/panel/chat/models'

import { chatModels, modelName } from './chat-models'

describe('modelName', () => {
  it('drops the provider the framework routes by and keeps the rest', () => {
    expect(modelName('openrouter/google/gemini-2.5-flash')).toBe('google/gemini-2.5-flash')
    expect(modelName('openai-chatgpt/gpt-6.2-sol')).toBe('gpt-6.2-sol')
    expect(modelName('anthropic/claude-sonnet-4-6')).toBe('anthropic/claude-sonnet-4-6')
  })
})

describe('chatModels', () => {
  it('names the defaults when nothing is set', () => {
    expect(chatModels({})).toEqual({
      chat: { openrouter: 'google/gemini-2.5-flash', codex: 'gpt-6.2-sol' },
      guide: { openrouter: 'openai/gpt-4.1-mini', codex: 'gpt-6.2-sol' },
    })
  })

  it('follows the settings the agents are built with', () => {
    const models = chatModels({
      FACTORY_CHAT_MODEL: 'openrouter/x/chat',
      FACTORY_GUIDE_MODEL: 'openrouter/x/guide',
      FACTORY_CHAT_CODEX_MODEL: 'openai-chatgpt/codex-y',
    })
    expect(models.chat).toEqual({ openrouter: 'x/chat', codex: 'codex-y' })
    expect(models.guide).toEqual({ openrouter: 'x/guide', codex: 'codex-y' })
  })

  it('gives the guides the model of the chat when they have none of their own', () => {
    expect(chatModels({ FACTORY_CHAT_MODEL: 'openrouter/x/chat' }).guide.openrouter).toBe('x/chat')
  })
})

describe('GET /api/panel/chat/models', () => {
  const policy = GET.policy as RoutePolicy<unknown, unknown, unknown>
  const input = (subject: { id: string } | null) => ({ subject, query: {}, body: {}, params: {} })

  it('is for the owner only', async () => {
    expect(await evaluateRoutePolicy(policy, input(null))).toMatchObject({ allowed: false })
    expect(await evaluateRoutePolicy(policy, input({ id: 'owner' }))).toEqual({ allowed: true })
  })
})

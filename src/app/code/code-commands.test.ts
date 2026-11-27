import { describe, expect, it } from 'vitest'

import { en } from '../lib/copy/en'
import { ptBR } from '../lib/copy/pt-BR'

import { CODE_COMMANDS, commandRefusal, matchCommands } from './code-commands'

describe('CODE_COMMANDS', () => {
  it.each([
    ['en', en],
    ['pt-BR', ptBR],
  ])('has a description in %s for every command', (_lang, copy) => {
    const about = copy.code.conversation.commands.about as Record<string, string>
    for (const command of CODE_COMMANDS) expect(about[command.name]?.trim()).toBeTruthy()
  })

  it('has unique names', () => {
    expect(new Set(CODE_COMMANDS.map((c) => c.name)).size).toBe(CODE_COMMANDS.length)
  })

  it('filters by prefix', () => {
    expect(matchCommands('pl').map((c) => c.name)).toEqual(['plan'])
    expect(matchCommands('').length).toBe(CODE_COMMANDS.length)
    expect(matchCommands('zzz')).toEqual([])
  })

  it('refuses by state', () => {
    const stop = { kind: 'stop' } as const
    expect(commandRefusal(stop, { state: 'idle', mode: 'code' })).toBe('notRunning')
    expect(commandRefusal(stop, { state: 'running', mode: 'code' })).toBeUndefined()
    expect(commandRefusal({ kind: 'mode', mode: 'code' }, { state: 'idle', mode: 'code' })).toBe(
      'sameMode',
    )
    expect(commandRefusal({ kind: 'end' }, { state: 'ended', mode: 'code' })).toBe('ended')
  })
})

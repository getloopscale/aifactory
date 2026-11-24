import { describe, expect, it } from 'vitest'

import { activityOf as activity, withoutTools } from './activity'
import { ptBR } from './copy/pt-BR'

// The words under test are those of the Portuguese dictionary.
const activityOf = (message: Parameters<typeof activity>[0]) => activity(message, ptBR.activity)

const call = (toolName: string, state: string) => ({
  type: 'dynamic-tool',
  toolName,
  toolCallId: toolName,
  state,
})

describe('what an answer did besides writing', () => {
  it('names what it looked at in plain words, once each', () => {
    const message = {
      parts: [
        call('list_tasks', 'output-available'),
        call('list_tasks', 'output-available'),
        call('inbox_items', 'output-available'),
        { type: 'text', text: 'x' },
      ],
    }
    expect(activityOf(message)).toEqual({
      looked: ['as tarefas', 'a caixa de entrada'],
      did: [],
      refused: [],
    })
  })

  it('names what it changed only once it finished, and what the owner refused', () => {
    const message = {
      parts: [
        call('retry_task', 'output-available'),
        call('approve_task', 'approval-requested'),
        call('update_repository', 'output-denied'),
        call('list_tasks', 'input-streaming'),
        call('mystery_tool', 'output-available'),
        call('start_job', 'output-denied'),
      ],
    }
    expect(activityOf(message)).toEqual({
      looked: ['mystery_tool'],
      did: ['começou uma tarefa de novo'],
      refused: ['salvou as configurações de um repositório', 'abriu uma issue e começou'],
    })
  })

  it('does not call a refused reading a refusal', () => {
    expect(activityOf({ parts: [call('list_tasks', 'output-denied')] })).toEqual({
      looked: [],
      did: [],
      refused: [],
    })
  })

  it('takes the tool calls out of the message and leaves the rest', () => {
    const message = {
      id: 'm',
      parts: [
        call('list_tasks', 'output-available'),
        { type: 'text', text: 'oi' },
        { type: 'tool-x' },
      ],
    }
    expect(withoutTools(message)).toEqual({ id: 'm', parts: [{ type: 'text', text: 'oi' }] })
  })
})

describe('in the language of the dictionary given', () => {
  it('says the same thing in English, and in English when none is given', async () => {
    const { en } = await import('./copy/en')
    const message = { parts: [call('list_tasks', 'output-available')] }
    expect(activity(message, en.activity).looked).toEqual([en.activity.reads.list_tasks])
    expect(activity(message).looked).toEqual([en.activity.reads.list_tasks])
    expect(activity(message, ptBR.activity).looked).toEqual([ptBR.activity.reads.list_tasks])
    expect(en.activity.reads.list_tasks).not.toBe(ptBR.activity.reads.list_tasks)
  })
})

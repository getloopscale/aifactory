import { describe, expect, it } from 'vitest'

import { GUIDE_IDS } from '../../shared/guides'

import { en } from './copy/en'
import { ptBR } from './copy/pt-BR'
import type { RepositoryView } from '../../shared/panel'

import {
  finishedChanges,
  focusOf,
  guideIn,
  guideFor,
  repoChanges,
  startersFor,
  toolNameOf,
  whereIs,
} from './guides'

describe('the guide of a page', () => {
  it('is picked by where the owner is, for every page of the menu but the chat', () => {
    const at = (path: string) => guideFor(path, en)?.id
    expect(at('/work')).toBe('board')
    expect(at('/tasks/12')).toBe('board')
    expect(at('/plans')).toBe('plans')
    expect(at('/plans/4')).toBe('plans')
    expect(at('/repositories')).toBe('repositories')
    expect(at('/inbox')).toBe('inbox')
    expect(at('/health')).toBe('health')
    expect(at('/agents')).toBe('agents')
    expect(at('/setup')).toBe('setup')
    for (const path of ['/', '/chat/abc', '/login', '/workshop', '/plansx', '/agentsx'])
      expect(at(path)).toBeUndefined()
  })

  it('has a name, a sentence about the page and suggestions for each one, and warns where keys are at risk', () => {
    for (const id of GUIDE_IDS) {
      const guide = guideIn(id, ptBR)
      expect(guide.id).toBe(id)
      expect(guide.name).toMatch(/^Guia d/)
      expect(guideIn(id, en).name).toMatch(/^Guide of/)
      expect(guideIn(id, en).about).not.toBe(guide.about)
      expect(guide.about.length).toBeGreaterThan(20)
      expect(guide.understand.length).toBeGreaterThan(0)
      expect(guide.act.length).toBeGreaterThan(0)
    }
    expect(guideIn('setup', ptBR).note).toContain('chaves')
    expect(guideIn('setup', en).note).toContain('keys')
    expect(guideIn('board', ptBR).note).toBeUndefined()
  })
})

describe('what the owner has open', () => {
  it("is the task or plan in the address, or the task in the board's search", () => {
    expect(focusOf('/tasks/7', '')).toEqual({ kind: 'task', id: 7 })
    expect(focusOf('/plans/3', '')).toEqual({ kind: 'plan', id: 3 })
    expect(focusOf('/work', '?task=9')).toEqual({ kind: 'task', id: 9 })
    expect(focusOf('/work', '?task=abc')).toBeUndefined()
    expect(focusOf('/work', '')).toBeUndefined()
    expect(focusOf('/inbox', '?task=9')).toBeUndefined()
  })

  it('is told to the guide in a line, so that "this task" means something', () => {
    expect(whereIs(guideIn('board', ptBR), '/work', '')).toBe(
      'Onde o dono está: página "Quadro" (/work).',
    )
    expect(whereIs(guideIn('board', ptBR), '/work', '?task=9')).toContain('a tarefa 9 aberta')
    expect(whereIs(guideIn('plans', ptBR), '/plans/3', '')).toContain('o plano 3 aberto')
  })

  it('puts the questions about the open item first, in the language of the owner', () => {
    for (const t of [en, ptBR]) {
      const board = guideIn('board', t)
      const plans = guideIn('plans', t)
      const none = startersFor(board, undefined, t)
      expect(none.understand).toEqual(board.understand)
      expect(none.act).toEqual(board.act)
      const task = startersFor(board, { kind: 'task', id: 9 }, t)
      expect(task.understand[0].text).toBe(t.guides.open.task(9).explain)
      expect(task.act[0].text).toBe(t.guides.open.task(9).act)
      expect(task.understand.slice(1)).toEqual(board.understand)
      const plan = startersFor(plans, { kind: 'plan', id: 3 }, t)
      expect(plan.understand[0].text).toBe(t.guides.open.plan(3).explain)
      expect(plan.act[0].text).toBe(t.guides.open.plan(3).act)
    }
    expect(startersFor(guideIn('board', ptBR), { kind: 'task', id: 9 }, ptBR).act[0].text).toBe(
      'O que devo fazer com a tarefa 9?',
    )
  })
})

describe('what a message did', () => {
  it('reads the tool of a part however the framework named it', () => {
    expect(toolNameOf({ type: 'dynamic-tool', toolName: 'retry_task' })).toBe('retry_task')
    expect(toolNameOf({ type: 'tool-list_tasks' })).toBe('list_tasks')
    expect(toolNameOf({ type: 'text' })).toBeUndefined()
    expect(toolNameOf({ type: 'dynamic-tool' })).toBeUndefined()
  })

  it('lists the changes that finished, and not the readings, the pending or the refused', () => {
    const ids = finishedChanges([
      {
        parts: [
          {
            type: 'dynamic-tool',
            toolName: 'retry_task',
            toolCallId: 'a',
            state: 'output-available',
          },
          {
            type: 'dynamic-tool',
            toolName: 'list_tasks',
            toolCallId: 'b',
            state: 'output-available',
          },
          {
            type: 'dynamic-tool',
            toolName: 'approve_task',
            toolCallId: 'c',
            state: 'approval-requested',
          },
          {
            type: 'dynamic-tool',
            toolName: 'update_repository',
            toolCallId: 'd',
            state: 'output-denied',
          },
          { type: 'tool-create_plan', toolCallId: 'e', state: 'output-available' },
          {
            type: 'dynamic-tool',
            toolName: 'update_agent_settings',
            toolCallId: 'f',
            state: 'output-available',
          },
          { type: 'tool-create_plan', state: 'output-available' },
        ],
      },
    ])
    expect(ids).toEqual(['a', 'e', 'f'])
  })
})

describe('what a save would change', () => {
  const repo = {
    enabled: true,
    checks: [{ name: 'unit', command: 'pnpm test' }],
    egress: [],
    baseBranch: null,
    releaseBranch: 'main',
    askQuestions: true,
    harness: null,
    reviewer: 'codex',
    releaseMode: 'manual',
  } as unknown as RepositoryView

  it('says before and after when the settings are known, and only what differs', () => {
    expect(
      repoChanges(repo, {
        releaseBranch: 'release',
        askQuestions: false,
        releaseMode: 'trial',
        checks: [
          { name: 'types', command: 'x' },
          { name: 'lint', command: 'y' },
        ],
        egress: ['pypi.org'],
        baseBranch: 'int',
        harness: 'codex',
        reviewer: null,
        enabled: true,
      }),
    ).toEqual([
      'Verificações: unit → types, lint',
      'Domínios extras do sandbox: nenhum → pypi.org',
      'Branch de integração: o padrão → int',
      'Branch de release: main → release',
      'O agente pode perguntar na issue: sim → não',
      'Agente construtor: o padrão → codex',
      'Revisor: codex → o padrão',
      'Release: só uma pessoa libera → só registra o que faria',
    ])
  })

  it('says only the new value when the current settings are not known, and skips what was not sent', () => {
    expect(
      repoChanges(undefined, {
        releaseBranch: null,
        enabled: false,
        checks: null,
        releaseMode: 'auto',
      }),
    ).toEqual([
      'Fábrica ativa neste repositório: não',
      'Verificações: o padrão (npm test)',
      'Branch de release: o padrão',
      'Release: um agente pode liberar',
    ])
    expect(repoChanges(undefined, { releaseBranch: undefined })).toEqual([])
    expect(repoChanges(repo, { unknown: 1 })).toEqual([])
    expect(repoChanges(repo, { releaseMode: 'weird' })).toEqual([
      'Release: só uma pessoa libera → o padrão da fábrica',
    ])
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { coordinatorAction, repository, task } from '../db/schema'

const sendBack = vi.hoisted(() => vi.fn())
vi.mock('../panel/actions', async (original) => ({
  ...(await original<typeof import('../panel/actions')>()),
  sendBackByCoordinator: sendBack,
}))

import { applyDecision, type ApplyDeps } from './apply'
import type { Decision } from './decide'
import type { TaskException } from './exceptions'
import type { ScopeDraft } from './scope'

const gap = { repository: 'o/framework', title: 'The router lacks X', body: 'It cannot do X.' }
const draft = (over: Partial<ScopeDraft> = {}): ScopeDraft => ({
  inScope: ['link the gap'],
  outOfScope: [],
  followUp: null,
  note: 'Link the gap issue.',
  gap,
  ...over,
})
const decision = (d: ScopeDraft): Decision => ({ action: 'scope', reason: 'plateau', draft: d })
const exception = { taskId: 1, kind: 'review_plateau', head: 'abc' } as unknown as TaskException

function setup(opts: { enabled?: boolean; open?: { number: number; title: string }[] } = {}) {
  const inserted: Record<string, unknown>[] = []
  const earlier: { reference: string }[] = []
  const rowsOf = (table: unknown) =>
    table === task
      ? [{ id: 1, repository: 'o/r', issueNumber: 5, stage: 'handoff', headSha: 'abc' }]
      : table === repository
        ? opts.enabled === undefined
          ? []
          : [{ enabled: opts.enabled }]
        : table === coordinatorAction
          ? earlier
          : []
  const chain = (rows: unknown[]): unknown =>
    new Proxy(
      {},
      {
        get: (_, key) =>
          key === 'then' ? (resolve: (v: unknown) => void) => resolve(rows) : () => chain(rows),
      },
    )
  const db = {
    select: () => ({ from: (table: unknown) => chain(rowsOf(table)) }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v)
        return { onConflictDoNothing: async () => {} }
      },
    }),
  }
  const tokens: string[] = []
  const created: unknown[] = []
  const deps = {
    db,
    github: {
      installationToken: async (repo: string) => {
        tokens.push(repo)
        return { token: `tok-${repo}`, expiresAt: new Date() }
      },
    },
    issues: {
      createIssue: async (repo: string, _t: string, issue: unknown) => {
        created.push([repo, issue])
        return { number: 77, url: 'u' }
      },
    },
    listOpenIssues: async () =>
      (opts.open ?? []).map((i) => ({ ...i, body: '', labels: [], state: 'open' as const })),
    readIssue: async () => ({ number: 5, title: 't', body: '', labels: [] }),
  } as unknown as ApplyDeps
  return { deps, inserted, tokens, created, earlier }
}

beforeEach(() => {
  sendBack.mockReset()
})

describe('applying a gap draft', () => {
  it('files the issue with the target repository token and sends the task back naming it', async () => {
    const { deps, inserted, tokens, created } = setup({ enabled: true })
    expect(await applyDecision(deps, exception, decision(draft()), 'auto')).toBe('applied')
    expect(tokens).toContain('o/framework')
    expect(created).toHaveLength(1)
    expect(sendBack.mock.calls[0][2]).toContain('o/framework#77')
    expect(inserted[0]).toMatchObject({
      outcome: 'applied',
      draft: { gapIssue: 'o/framework#77' },
    })
  })

  it('names an open issue with the same title instead of filing another', async () => {
    const { deps, created } = setup({
      enabled: true,
      open: [{ number: 12, title: 'the router lacks x' }],
    })
    await applyDecision(deps, exception, decision(draft()), 'auto')
    expect(created).toHaveLength(0)
    expect(sendBack.mock.calls[0][2]).toContain('o/framework#12')
  })

  it('files in the task repository without it being enabled', async () => {
    const { deps, created } = setup()
    await applyDecision(
      deps,
      exception,
      decision(draft({ gap: { ...gap, repository: 'o/r' } })),
      'auto',
    )
    expect(created).toHaveLength(1)
  })

  it('refuses a repository that is neither the task’s nor enabled, and files nothing', async () => {
    for (const enabled of [undefined, false]) {
      const { deps, created, tokens, inserted } = setup({ enabled })
      expect(await applyDecision(deps, exception, decision(draft()), 'auto')).toBe('refused')
      expect(created).toHaveLength(0)
      expect(tokens).not.toContain('o/framework')
      expect(sendBack).not.toHaveBeenCalled()
      expect(inserted[0]).toMatchObject({ outcome: 'refused' })
    }
  })

  it('reuses the issue an earlier decision recorded when the send-back failed before', async () => {
    const { deps, created, earlier } = setup({ enabled: true })
    earlier.push({ reference: 'o/framework#40' })
    await applyDecision(deps, exception, decision(draft()), 'auto')
    expect(created).toHaveLength(0)
    expect(sendBack.mock.calls[0][2]).toContain('o/framework#40')
  })

  it('records the reference when the send-back fails after the issue was filed', async () => {
    const { deps, inserted } = setup({ enabled: true })
    sendBack.mockImplementation(() => {
      throw new Error('boom')
    })
    expect(await applyDecision(deps, exception, decision(draft()), 'auto')).toBe('failed')
    expect(inserted[0]).toMatchObject({ outcome: 'failed', draft: { gapIssue: 'o/framework#77' } })
  })

  it('records a failure when the target repository is inaccessible', async () => {
    const { deps, created, inserted } = setup({ enabled: true })
    deps.github.installationToken = async (repo: string) => {
      if (repo === 'o/framework') throw new Error('not installed')
      return { token: 't', expiresAt: new Date() }
    }
    expect(await applyDecision(deps, exception, decision(draft()), 'auto')).toBe('failed')
    expect(created).toHaveLength(0)
    expect(inserted[0]).toMatchObject({ outcome: 'failed' })
  })

  it('only records the decision in trial', async () => {
    const { deps, created, inserted } = setup({ enabled: true })
    expect(await applyDecision(deps, exception, decision(draft()), 'trial')).toBe('trial')
    expect(created).toHaveLength(0)
    expect(sendBack).not.toHaveBeenCalled()
    expect(inserted[0]).toMatchObject({ outcome: 'trial' })
  })
})

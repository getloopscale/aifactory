// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CoordinatorActionView, InboxItem, TaskCard } from '../../../shared/panel'
import { card, decision, inboxItem, refusal, servePanel } from '../../../test/floor-fixtures'
import { en } from '../../lib/copy/en'

import Page from './page'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function serve({
  items = [],
  tasks = [],
  applied = [],
}: {
  items?: InboxItem[]
  tasks?: TaskCard[]
  applied?: CoordinatorActionView[]
} = {}) {
  servePanel({
    '/api/panel/inbox': { items },
    '/api/panel/tasks': { tasks },
    '/api/panel/coordinator?outcome=applied': { actions: applied },
  })
}

const show = () =>
  render(
    <MemoryRouter initialEntries={['/floor/attention']}>
      <Page />
    </MemoryRouter>,
  )

const heading = () => screen.getByRole('heading', { level: 1 }).textContent
/** The row of a task the factory handles, once the page has it. */
const handled = async (title: string) => within((await screen.findByText(title)).closest('a')!)

describe('the attention view of the floor', () => {
  it('says it is loading until the inbox and the tasks arrive, with no count in the heading', () => {
    serve()

    show()

    expect(heading()).toBe(en.floor.views.attention)
    expect(screen.getAllByText(en.layout.loading)).toHaveLength(2)
  })

  it('shows the error of an inbox that could not be read', async () => {
    servePanel({ '/api/panel/inbox': refusal('the inbox is out') })

    show()

    expect(await screen.findByText('the inbox is out')).toBeDefined()
  })

  it('says nothing waits for the owner and the factory has no exception when both are empty', async () => {
    serve()

    show()

    expect(await screen.findByText(en.floor.attention.noneDetail)).toBeDefined()
    expect(heading()).toBe('Nothing waits for you')
    expect(await screen.findByText(en.floor.attention.factoryNone)).toBeDefined()
    expect(screen.queryByText(/Release alerts/)).toBeNull()
  })

  it('shows what is asked of the owner, why the coordinator escalated it and where to act', async () => {
    const task = card({
      id: 4,
      title: 'Stuck one',
      stage: 'handoff',
      costUsd: 1.25,
      pullRequestUrl: 'https://example.test/pull/9',
      lastAgent: { agent: 'codex', model: 'gpt-9' },
    })
    serve({
      tasks: [task],
      items: [
        inboxItem(task, {
          kind: 'handoff',
          summary: 'Three attempts',
          coordinatorReason: 'no way on',
        }),
      ],
    })

    show()

    expect(await screen.findByText('Three attempts')).toBeDefined()
    expect(heading()).toBe('1 thing waits for you')
    expect(screen.getByText(/· Stuck one/)).toBeDefined()
    expect(screen.getByText(en.coordinator.escalatedBy('no way on'))).toBeDefined()
    expect(screen.getByText('$1.25')).toBeDefined()
    expect(screen.getByText('gpt-9')).toBeDefined()
    const open = screen.getByRole('link', { name: en.floor.attention.open.handoff })
    expect(open.getAttribute('href')).toBe('/tasks/4')
    const pull = screen.getByRole('link', { name: en.floor.attention.pullRequest })
    expect(pull.getAttribute('href')).toBe('https://example.test/pull/9')
  })

  it('offers no pull request and no escalation for a question that has neither', async () => {
    const task = card({ id: 4, title: 'Asking one', stage: 'waiting' })
    serve({ tasks: [task], items: [inboxItem(task, { kind: 'question', summary: 'Which one?' })] })

    show()

    expect(await screen.findByText('Which one?')).toBeDefined()
    expect(screen.getByRole('link', { name: en.floor.attention.open.question })).toBeDefined()
    expect(screen.queryByRole('link', { name: en.floor.attention.pullRequest })).toBeNull()
    expect(screen.queryByText(/The coordinator escalated it/)).toBeNull()
  })

  it('does not list under the factory a task that waits for the owner', async () => {
    const task = card({ id: 4, title: 'Stuck one', stage: 'handoff' })
    serve({ tasks: [task], items: [inboxItem(task, { kind: 'handoff' })] })

    show()

    expect(await screen.findByText(en.floor.attention.factoryNone)).toBeDefined()
    expect(screen.getAllByText(en.floor.attention.factory(0)).length).toBeGreaterThan(0)
  })

  it('shows the release alerts by repository, with the latest one and how many', async () => {
    const red = (id: number, repository: string, at: string, summary: string) =>
      inboxItem(card({ id, repository, stage: 'released' }), { kind: 'main_red', at, summary })
    serve({
      items: [
        red(1, 'paulo/app', '2026-11-04T10:00:00Z', 'v1.0.0 went red'),
        red(2, 'paulo/app', '2026-11-04T12:00:00Z', 'v1.2.0 went red'),
        red(3, 'paulo/app', '2026-11-04T11:00:00Z', 'v1.1.0 went red'),
        red(4, 'paulo/site', '2026-11-04T09:00:00Z', 'v0.3.0 went red'),
      ],
    })

    show()

    expect(await screen.findByText(en.floor.attention.alerts(4))).toBeDefined()
    const app = within(screen.getByText('v1.2.0 went red').closest('a')!)
    expect(app.getByText('app')).toBeDefined()
    expect(app.getByText(en.floor.attention.releases(3))).toBeDefined()
    expect(screen.getByText('v1.2.0 went red').closest('a')?.getAttribute('href')).toBe('/tasks/2')
    const site = within(screen.getByText('v0.3.0 went red').closest('a')!)
    expect(site.getByText(en.floor.attention.releases(1))).toBeDefined()
    expect(screen.queryByText('v1.0.0 went red')).toBeNull()
    expect(heading()).toBe('Nothing waits for you')
  })

  it('leaves a failure the factory repeats out of the count and says when it runs again', async () => {
    const task = card({
      id: 6,
      title: 'Out of quota',
      stage: 'failed',
      retryable: 'quota',
      retryAt: new Date(Date.now() + 2 * 3600_000 + 60_000).toISOString(),
    })
    serve({ tasks: [task], items: [inboxItem(task, { kind: 'failed' })] })

    show()

    const row = await handled('Out of quota')
    expect(row.getByText(`${en.floor.retry.quota} · ${en.time.runsInHours(2)}`)).toBeDefined()
    await waitFor(() => expect(heading()).toBe('Nothing waits for you'))
    expect(screen.getAllByText(en.floor.attention.factory(1)).length).toBeGreaterThan(0)
  })

  it('says which branch a task held by a red base waits for', async () => {
    serve({
      tasks: [
        card({
          title: 'Held one',
          stage: 'done',
          waitingOnBase: {
            branch: 'workspace',
            checks: ['test', 'lint'],
            since: '2026-11-04T10:00:00Z',
          },
        }),
      ],
    })

    show()

    const row = await handled('Held one')
    expect(row.getByText(en.floor.waitingOnBase('workspace', 2))).toBeDefined()
  })

  it('says why work was sent back', async () => {
    serve({
      tasks: [
        card({
          title: 'Returned one',
          stage: 'intake',
          returned: { reason: 'base_conflict', at: '2026-11-04T10:00:00Z', note: null },
        }),
      ],
    })

    show()

    const row = await handled('Returned one')
    expect(row.getByText(en.floor.returned.base_conflict)).toBeDefined()
  })

  it("gives the coordinator's latest applied decision as the reason, and names its action", async () => {
    serve({
      tasks: [card({ id: 8, title: 'Failed one', stage: 'failed' })],
      applied: [
        decision({ id: 2, taskId: 8, action: 'send_back', reason: 'Sent back with the output' }),
        decision({ id: 1, taskId: 8, action: 'scope', reason: 'An older reason' }),
      ],
    })

    show()

    const row = await handled('Failed one')
    expect(await row.findByText('Sent back with the output')).toBeDefined()
    expect(row.getByText(/app · send_back ·/)).toBeDefined()
    expect(row.getByText('#7')).toBeDefined()
    expect(screen.queryByText('An older reason')).toBeNull()
  })

  it('says the coordinator reads a stopped task next when nothing was decided for it', async () => {
    serve({
      tasks: [card({ id: 8, title: 'Failed one', stage: 'failed' })],
      applied: [decision({ taskId: 99 })],
    })

    show()

    const row = await handled('Failed one')
    expect(row.getByText(en.floor.handledNoReason)).toBeDefined()
    expect(row.queryByText(/send_back/)).toBeNull()
  })

  it('lists what the factory handles with the most recently touched first, and nothing else', async () => {
    serve({
      tasks: [
        card({ id: 1, title: 'Older failure', stage: 'failed', updatedAt: '2026-11-04T10:00:00Z' }),
        card({ id: 2, title: 'Newer failure', stage: 'failed', updatedAt: '2026-11-04T11:00:00Z' }),
        card({ id: 3, title: 'Building one', stage: 'build' }),
      ],
    })

    show()

    await handled('Newer failure')
    const titles = screen
      .getAllByRole('link')
      .map((link) => /Older failure|Newer failure|Building one/.exec(link.textContent ?? '')?.[0])
      .filter((title) => title)
    expect(titles).toEqual(['Newer failure', 'Older failure'])
  })
})

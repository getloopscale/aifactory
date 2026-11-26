// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CoordinatorActionView, InboxItem, PulseReport, TaskCard } from '../../shared/panel'
import { card, decision, inboxItem, refusal, servePanel } from '../../test/floor-fixtures'
import { en } from '../lib/copy/en'
import { WidthContext, type WidthClass } from '../lib/media'

import Page from './page'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const PULSE: PulseReport = {
  deliveredLastHour: 2,
  deliveredLast24Hours: 9,
  leadTimeP50Minutes: 41.6,
  queued: 4,
  working: 1,
}

/** Answers what the page reads; the crew and an open task get the server's 404. */
function serve({
  tasks = [],
  items = [],
  actions = [],
  pulse = PULSE,
}: {
  tasks?: TaskCard[]
  items?: InboxItem[]
  actions?: CoordinatorActionView[]
  pulse?: PulseReport
} = {}) {
  servePanel({
    '/api/panel/tasks': { tasks },
    '/api/panel/inbox': { items },
    '/api/panel/pulse': pulse,
    '/api/panel/coordinator': { actions },
  })
}

function show(at = '/floor', width: WidthClass = 'expanded') {
  render(
    <MemoryRouter initialEntries={[at]}>
      <WidthContext.Provider value={width}>
        <Page />
      </WidthContext.Provider>
    </MemoryRouter>,
  )
}

/** The group of rows under a heading, once the tasks arrived. */
async function section(state: keyof typeof en.floor.sections) {
  await waitFor(() => expect(screen.queryByText(en.layout.loading)).toBeNull())
  return within(screen.getByRole('region', { name: en.floor.sections[state].title }))
}

describe('the floor', () => {
  it('says it is loading until the tasks arrive, with no number for the day', () => {
    serve()

    show()

    expect(screen.getByText(en.layout.loading)).toBeDefined()
    expect(screen.getAllByText('…')).toHaveLength(4)
  })

  it('says what each group is missing when there is no task', async () => {
    serve()

    show()

    expect((await section('owner')).getByText(en.floor.sections.owner.empty)).toBeDefined()
    expect((await section('queued')).getByText(en.floor.sections.queued.empty)).toBeDefined()
    expect((await section('delivered')).getByText(en.floor.sections.delivered.empty)).toBeDefined()
  })

  it('shows the error of a read that failed', async () => {
    servePanel({
      '/api/panel/tasks': refusal('the tasks are out'),
      '/api/panel/inbox': { items: [] },
    })

    show()

    expect(await screen.findByText('the tasks are out')).toBeDefined()
  })

  it('lists a task the inbox asks about under the owner, with what is wanted', async () => {
    const task = card({ id: 1, title: 'Asking one', stage: 'waiting' })
    serve({ tasks: [task], items: [inboxItem(task, { kind: 'question', summary: 'Which one?' })] })

    show()

    const owner = await section('owner')
    expect(owner.getByText('Asking one')).toBeDefined()
    expect(owner.getByText(en.inbox.question)).toBeDefined()
    expect(owner.getByText('Which one?')).toBeDefined()
  })

  it('names the checks the factory runs on a task', async () => {
    serve({
      tasks: [card({ stage: 'verify', working: { step: 'checks', checks: ['lint', 'test'] } })],
    })

    show()

    const moving = await section('moving')
    expect(moving.getByText(en.board.steps.checks)).toBeDefined()
    expect(moving.getByText('lint, test')).toBeDefined()
  })

  it('says the step of the agent at work on a task', async () => {
    serve({
      tasks: [card({ working: { step: 'building', agent: 'codex', model: 'gpt-9', attempt: 2 } })],
    })

    show()

    expect((await section('moving')).getByText('building · attempt 2')).toBeDefined()
  })

  it('says approved work nobody works on waits to integrate', async () => {
    serve({ tasks: [card({ stage: 'done' })] })

    show()

    expect((await section('moving')).getByText(en.floor.waitsMerge)).toBeDefined()
  })

  it('says what holds a task on the line when something does', async () => {
    serve({
      tasks: [card({ stage: 'merge', queue: { position: 2, reasons: null, readiness: null } })],
    })

    show()

    expect((await section('moving')).getByText('Place 2 in the queue')).toBeDefined()
  })

  it('says a stopped task with no known reason waits for the coordinator', async () => {
    serve({
      tasks: [card({ id: 3, stage: 'failed' })],
      actions: [decision({ taskId: 3, reason: 'Escalated before' })],
    })

    show()

    const factory = await section('factory')
    expect(factory.getByText(en.floor.handledNoReason)).toBeDefined()
    expect(factory.queryByText('Escalated before')).toBeNull()
  })

  it("says why the factory holds a task, with the coordinator's latest reason under it", async () => {
    const task = card({
      id: 3,
      stage: 'done',
      waitingOnBase: { branch: 'workspace', checks: ['test'], since: '2026-11-04T10:00:00Z' },
    })
    serve({
      tasks: [task],
      actions: [
        decision({ id: 2, taskId: 3, reason: 'The base is red' }),
        decision({ id: 1, taskId: 3, reason: 'An older reason' }),
      ],
    })

    show()

    const factory = await section('factory')
    expect(factory.getByText(en.floor.waitingOnBase('workspace', 1))).toBeDefined()
    expect(await factory.findByText('The base is red')).toBeDefined()
    expect(factory.queryByText('An older reason')).toBeNull()
  })

  it('says the place of a queued task, or only that it waits when it has none', async () => {
    serve({
      tasks: [
        card({ id: 1, stage: 'intake', queue: { position: 3, reasons: null, readiness: null } }),
        card({ id: 2, stage: 'intake' }),
      ],
    })

    show()

    const queued = await section('queued')
    expect(queued.getByText('Place 3 in the queue')).toBeDefined()
    expect(queued.getByText(en.floor.queuedNoPlace)).toBeDefined()
  })

  it('names the release of delivered work, else its pre-release, else says integrated', async () => {
    const tag = (name: string) => ({ tag: name, url: `https://example.test/${name}` })
    serve({
      tasks: [
        card({ id: 1, stage: 'released', release: tag('v1.2.0'), preRelease: tag('v1.2.0-rc.1') }),
        card({ id: 2, stage: 'done', integrated: true, preRelease: tag('v1.3.0-rc.1') }),
        card({ id: 3, stage: 'done', integrated: true }),
      ],
    })

    show()

    const delivered = await section('delivered')
    expect(delivered.getByText('v1.2.0')).toBeDefined()
    expect(delivered.getByText('v1.3.0-rc.1')).toBeDefined()
    expect(delivered.getByText(en.floor.delivered.integrated)).toBeDefined()
  })

  it('lists the rows of a group with the most recently touched first', async () => {
    serve({
      tasks: [
        card({ id: 1, title: 'Older', stage: 'intake', updatedAt: '2026-11-04T10:00:00Z' }),
        card({ id: 2, title: 'Newer', stage: 'intake', updatedAt: '2026-11-04T11:00:00Z' }),
      ],
    })

    show()

    const rows = (await section('queued')).getAllByRole('listitem')
    expect(rows.map((row) => within(row).getByText(/Older|Newer/).textContent)).toEqual([
      'Newer',
      'Older',
    ])
  })

  it('shows the six latest deliveries and links to the board for the rest', async () => {
    serve({
      tasks: Array.from({ length: 7 }, (_, index) =>
        card({ id: index + 1, stage: 'released', title: `Delivery ${index + 1}` }),
      ),
    })

    show()

    const delivered = await section('delivered')
    expect(delivered.getAllByRole('listitem')).toHaveLength(6)
    const all = delivered.getByRole('link', { name: en.floor.delivered.all(7) })
    expect(all.getAttribute('href')).toBe('/work')
  })

  it('offers no link to the board when every delivery is shown', async () => {
    serve({ tasks: [card({ stage: 'released' })] })

    show()

    expect((await section('delivered')).queryByRole('link', { name: /on the board/ })).toBeNull()
  })

  it('counts the tasks that wait for the owner on the attention tab', async () => {
    const task = card({ id: 1, stage: 'handoff' })
    serve({ tasks: [task], items: [inboxItem(task, { kind: 'handoff' })] })

    show()

    const tab = await screen.findByRole('link', { name: /^Attention\s*1$/ })
    expect(tab.getAttribute('href')).toBe('/floor/attention')
  })

  it("shows the day's numbers, with the median lead time in whole minutes", async () => {
    serve()

    show()

    expect(await screen.findByText('42 min')).toBeDefined()
    expect(screen.getByText('9')).toBeDefined()
  })

  it('says there was no delivery when there is no lead time to show', async () => {
    serve({ pulse: { ...PULSE, leadTimeP50Minutes: null } })

    show()

    expect(await screen.findByText(en.floor.pulse.noDelivery)).toBeDefined()
  })

  it("lists the coordinator's latest decisions with what became of each", async () => {
    serve({
      actions: [
        decision({ id: 1, taskId: 11, action: 'send_back', outcome: 'applied', title: 'One' }),
        decision({ id: 2, taskId: 12, action: 'escalate', outcome: 'escalated', title: 'Two' }),
        decision({ id: 3, taskId: 13, action: 'scope', outcome: 'failed', title: 'Three' }),
        decision({ id: 4, taskId: 14, action: 'wait', outcome: 'deferred', title: 'Four' }),
      ],
    })

    show()

    const one = (await screen.findByText('send_back · Applied')).closest('a')
    expect(one?.getAttribute('href')).toBe('/floor?task=11')
    expect(one?.textContent).toContain('app #7 One')
    expect(screen.getByText('escalate · Escalated')).toBeDefined()
    expect(screen.getByText('scope · Failed')).toBeDefined()
    expect(screen.getByText('wait · Read again later')).toBeDefined()
  })

  it('shows no more than the seven latest decisions', async () => {
    serve({
      actions: Array.from({ length: 8 }, (_, index) =>
        decision({ id: index + 1, taskId: index + 1, title: `Decision ${index + 1}` }),
      ),
    })

    show()

    await screen.findByText(/Decision 1$/)
    expect(screen.getAllByText(/Decision \d$/)).toHaveLength(7)
  })

  it('docks an open task beside the line on a wide screen, and closes it', async () => {
    serve({ tasks: [card({ id: 5 })] })
    show('/floor?task=5')
    expect(screen.getByRole('complementary', { name: en.work.sheetTitle })).toBeDefined()
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.keyDown(document.body, { key: 'Escape' })

    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: en.work.sheetTitle })).toBeNull(),
    )
  })

  it('opens a task over the line on a narrow screen, and closes it', async () => {
    serve({ tasks: [card({ id: 5 })] })
    show('/floor?task=5', 'compact')
    const sheet = await screen.findByRole('dialog')
    const full = within(sheet).getByRole('link', { name: en.work.openInFull })
    expect(full.getAttribute('href')).toBe('/tasks/5')

    fireEvent.keyDown(sheet, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('opens no task when the address names none', async () => {
    serve()

    show('/floor', 'compact')

    await section('owner')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('complementary', { name: en.work.sheetTitle })).toBeNull()
  })
})

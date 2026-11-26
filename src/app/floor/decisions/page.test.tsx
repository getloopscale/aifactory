// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CoordinatorActionView, InboxItem } from '../../../shared/panel'
import { card, decision, inboxItem, refusal, servePanel } from '../../../test/floor-fixtures'
import { en } from '../../lib/copy/en'

import Page from './page'

/** Where the page keeps the time of the owner's last visit. */
const SEEN_KEY = 'aifactory.floor.decisionsSeen'

afterEach(() => {
  window.localStorage.clear()
  cleanup()
  vi.unstubAllGlobals()
})

function serve(actions: CoordinatorActionView[], items: InboxItem[] = []) {
  servePanel({
    '/api/panel/coordinator': { actions },
    '/api/panel/inbox': { items },
  })
}

const visitedAt = (iso: string) => window.localStorage.setItem(SEEN_KEY, String(Date.parse(iso)))

const show = () =>
  render(
    <MemoryRouter initialEntries={['/floor/decisions']}>
      <Page />
    </MemoryRouter>,
  )

/** Three decisions, newest first, an hour apart. */
const THREE = [
  decision({ id: 3, taskId: 13, title: 'Newest', at: '2026-11-04T12:00:00Z' }),
  decision({ id: 2, taskId: 12, title: 'Middle', at: '2026-11-04T11:00:00Z' }),
  decision({ id: 1, taskId: 11, title: 'Oldest', at: '2026-11-04T10:00:00Z' }),
]

/** The text of each row of the list, in order, with the mark where the owner stopped reading. */
const rows = () =>
  within(screen.getByRole('list'))
    .getAllByRole('listitem')
    .map((item) => /Newest|Middle|Oldest|you had read up to here/.exec(item.textContent ?? '')?.[0])

describe('the decisions of the floor', () => {
  it('says it is loading until the decisions arrive', () => {
    serve(THREE)

    show()

    expect(screen.getByText(en.layout.loading)).toBeDefined()
  })

  it('says the coordinator decided nothing when there is no decision', async () => {
    serve([])

    show()

    expect(await screen.findByText(en.coordinator.empty)).toBeDefined()
  })

  it('shows the error of a read that failed', async () => {
    servePanel({ '/api/panel/coordinator': refusal('the coordinator is out') })

    show()

    expect(await screen.findByText('the coordinator is out')).toBeDefined()
  })

  it('shows a decision with its task, its action, its exception, its reason and its outcome', async () => {
    serve([
      decision({
        taskId: 11,
        title: 'Add truncate',
        action: 'send_back',
        exceptionKind: 'checks_red',
        outcome: 'escalated',
        reason: 'The checks failed twice',
      }),
    ])

    show()

    const row = (await screen.findByText('Add truncate')).closest('a')!
    expect(row.getAttribute('href')).toBe('/tasks/11')
    expect(within(row).getByText('app #7 · send_back · checks_red')).toBeDefined()
    expect(within(row).getByText('The checks failed twice')).toBeDefined()
    expect(within(row).getByText('Escalated')).toBeDefined()
  })

  it('lists the latest decisions with no mark on a first visit', async () => {
    serve(THREE)

    show()

    expect(await screen.findByText(en.floor.decisions.firstVisit)).toBeDefined()
    expect(rows()).toEqual(['Newest', 'Middle', 'Oldest'])
  })

  it('counts the decisions since the last visit and marks where the owner stopped reading', async () => {
    visitedAt('2026-11-04T11:30:00Z')
    serve(THREE)

    show()

    expect(await screen.findByText(en.floor.decisions.unread(1))).toBeDefined()
    expect(rows()).toEqual(['Newest', 'you had read up to here', 'Middle', 'Oldest'])
  })

  it('says nothing is new, with no mark, when every decision was read', async () => {
    visitedAt('2026-11-04T13:00:00Z')
    serve(THREE)

    show()

    await screen.findByText('Newest')
    expect(screen.getByText('Nothing new since your last visit')).toBeDefined()
    expect(rows()).toEqual(['Newest', 'Middle', 'Oldest'])
  })

  it('counts every decision, with no mark, when all came after the last visit', async () => {
    visitedAt('2026-11-04T09:00:00Z')
    serve(THREE)

    show()

    expect(await screen.findByText(en.floor.decisions.unread(3))).toBeDefined()
    expect(rows()).toEqual(['Newest', 'Middle', 'Oldest'])
  })

  it('keeps the time of this visit for the next one', () => {
    const before = Date.now()
    serve(THREE)

    show()

    expect(Number(window.localStorage.getItem(SEEN_KEY))).toBeGreaterThanOrEqual(before)
  })

  it('links to every decision with filters', () => {
    serve(THREE)

    show()

    const all = screen.getByRole('link', { name: en.floor.decisions.all })
    expect(all.getAttribute('href')).toBe('/coordinator')
  })

  it('counts the tasks that wait for the owner on the attention tab', async () => {
    serve(THREE, [inboxItem(card({ id: 1, stage: 'handoff' }), { kind: 'handoff' })])

    show()

    expect(await screen.findByRole('link', { name: /^Attention\s*1$/ })).toBeDefined()
  })
})

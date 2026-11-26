// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CostGroup, InboxItem, MetricRow, TaskCard } from '../../../shared/panel'
import { card, inboxItem, refusal, servePanel } from '../../../test/floor-fixtures'
import { en } from '../../lib/copy/en'

import Page from './page'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const metric = (over: Partial<MetricRow> = {}): MetricRow => ({
  metric: 'first_review_approval',
  label: 'Approved on the first review',
  unit: 'share',
  worse: 'down',
  repository: 'paulo/app',
  day: '2026-11-04',
  value: 0.8,
  samples: 5,
  mean: null,
  sd: null,
  band: 'in_band',
  rules: [],
  ...over,
})

const group = (over: Partial<CostGroup> = {}): CostGroup => ({
  harness: 'claude-code',
  role: 'builder',
  runs: 2,
  reportedRuns: 2,
  costUsd: 1,
  avgDurationMs: 30_000,
  failed: 0,
  quota: 0,
  ...over,
})

function serve({
  tasks = [],
  items = [],
  rows = [],
  groups = [],
}: {
  tasks?: TaskCard[]
  items?: InboxItem[]
  rows?: MetricRow[]
  groups?: CostGroup[]
} = {}) {
  servePanel({
    '/api/panel/tasks': { tasks },
    '/api/panel/inbox': { items },
    '/api/panel/metrics': { rows, signals: [] },
    '/api/panel/health': {
      cost: { last24HoursUsd: 0, last7DaysUsd: 0, totalUsd: 0, tasks: 0, avgPerTaskUsd: 0, groups },
      findings: [],
    },
  })
}

const show = () =>
  render(
    <MemoryRouter initialEntries={['/floor/projects']}>
      <Page />
    </MemoryRouter>,
  )

/** The table row of a repository, once the page has it. */
const project = async (repository: string) =>
  within(await screen.findByRole('row', { name: new RegExp(`^${repository}`) }))

describe('the projects of the floor', () => {
  it('says it is loading until the tasks arrive', () => {
    serve()

    show()

    expect(screen.getByText(en.layout.loading)).toBeDefined()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('shows the error of a read that failed', async () => {
    servePanel({ '/api/panel/tasks': refusal('the tasks are out') })

    show()

    expect(await screen.findByText('the tasks are out')).toBeDefined()
  })

  it('counts the open tasks of a repository by who moves them next', async () => {
    const asking = card({ id: 3, stage: 'waiting' })
    serve({
      tasks: [
        card({ id: 1, stage: 'build' }),
        card({ id: 2, stage: 'review' }),
        asking,
        card({ id: 4, stage: 'failed' }),
        card({ id: 5, stage: 'intake' }),
        card({ id: 6, stage: 'released' }),
      ],
      items: [inboxItem(asking)],
    })

    show()

    const row = await project('paulo/app')
    await waitFor(() => expect(row.getByText('1 waits for you')).toBeDefined())
    expect(row.getByText('2 moving')).toBeDefined()
    expect(row.getByText('1 the factory handles it')).toBeDefined()
    expect(row.getByText('1 queued')).toBeDefined()
    expect(row.queryByText(/delivered/)).toBeNull()
    expect(row.queryByText(en.floor.projects.nothingOpen)).toBeNull()
  })

  it('says nothing is open in a repository whose tasks were all delivered', async () => {
    serve({ tasks: [card({ stage: 'released' })] })

    show()

    expect((await project('paulo/app')).getByText(en.floor.projects.nothingOpen)).toBeDefined()
  })

  it('lists the repository with more open tasks first, and equal ones by name', async () => {
    serve({
      tasks: [
        card({ id: 1, repository: 'paulo/zeta', stage: 'build' }),
        card({ id: 2, repository: 'paulo/beta', stage: 'build' }),
        card({ id: 3, repository: 'paulo/quiet', stage: 'released' }),
        card({ id: 4, repository: 'paulo/busy', stage: 'build' }),
        card({ id: 5, repository: 'paulo/busy', stage: 'intake' }),
      ],
    })

    show()

    await project('paulo/busy')
    const names = screen
      .getAllByRole('rowheader')
      .map((cell) => cell.firstElementChild?.textContent)
    expect(names).toEqual(['paulo/busy', 'paulo/beta', 'paulo/zeta', 'paulo/quiet'])
  })

  it('counts the tasks that wait for the owner on the attention tab', async () => {
    const task = card({ id: 1, stage: 'handoff' })
    serve({ tasks: [task], items: [inboxItem(task, { kind: 'handoff' })] })

    show()

    expect(await screen.findByRole('link', { name: /^Attention\s*1$/ })).toBeDefined()
  })

  it('says once that no indicator has a point when none has', async () => {
    serve({ tasks: [card()] })

    show()

    await project('paulo/app')
    expect(screen.getAllByText(en.floor.projects.noMetrics)).toHaveLength(1)
    expect(screen.getAllByRole('columnheader')).toHaveLength(1)
  })

  it('says nothing about indicators when there is no repository to show', async () => {
    serve()

    show()

    await screen.findByRole('table')
    expect(screen.queryByText(en.floor.projects.noMetrics)).toBeNull()
  })

  it('gives a column to each indicator it shows that has a point, and to no other', async () => {
    serve({
      tasks: [card()],
      rows: [
        metric({ metric: 'rework_rounds', label: 'Rework rounds', unit: 'count', value: 1.5 }),
        metric({ metric: 'first_review_approval', label: 'Approved first' }),
        metric({ metric: 'something_else', label: 'Not shown here' }),
      ],
    })

    show()

    await screen.findByRole('columnheader', { name: 'Rework rounds' })
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      en.floor.projects.heading,
      'Approved first',
      'Rework rounds',
    ])
    expect(screen.queryByText('Not shown here')).toBeNull()
  })

  it('shows the latest value of an indicator, with the usual one when there is a baseline', async () => {
    serve({
      tasks: [card()],
      rows: [metric({ value: 0.8, mean: 0.7 })],
    })

    show()

    const row = await project('paulo/app')
    expect(await row.findByText('80%')).toBeDefined()
    expect(row.getByText('usual 70%')).toBeDefined()
    expect(row.queryByText(en.floor.projects.outOfBand)).toBeNull()
  })

  it('shows no usual value for an indicator with no baseline yet', async () => {
    serve({ tasks: [card()], rows: [metric({ value: 0.8, mean: null, band: 'no_baseline' })] })

    show()

    const row = await project('paulo/app')
    expect(await row.findByText('80%')).toBeDefined()
    expect(row.queryByText(/usual/)).toBeNull()
  })

  it.each(['show', 'act'] as const)(
    'marks an indicator whose band is %s as out of its band',
    async (band) => {
      serve({ tasks: [card()], rows: [metric({ band })] })

      show()

      expect(
        await (await project('paulo/app')).findByText(en.floor.projects.outOfBand),
      ).toBeDefined()
    },
  )

  it('leaves empty the cell of an indicator a repository has no point for', async () => {
    serve({
      tasks: [card()],
      rows: [
        metric({ repository: 'paulo/app' }),
        metric({
          repository: 'paulo/other',
          metric: 'cost_per_delivery',
          label: 'Cost',
          unit: 'usd',
          value: 2,
        }),
      ],
    })

    show()

    const row = await project('paulo/app')
    await row.findByText('80%')
    expect(row.getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['80%', ''])
  })

  it('says a repository has no indicator yet when only others have', async () => {
    serve({
      tasks: [card({ repository: 'paulo/new' })],
      rows: [metric({ repository: 'paulo/app' })],
    })

    show()

    const row = await project('paulo/new')
    expect(await row.findByText(en.floor.projects.noMetrics)).toBeDefined()
  })

  it('lists a repository that has an indicator and no task', async () => {
    serve({ rows: [metric({ repository: 'paulo/measured' })] })

    show()

    expect((await project('paulo/measured')).getByText('80%')).toBeDefined()
  })

  it('does not take the indicators of every repository together for a repository', async () => {
    serve({ tasks: [card()], rows: [metric({ repository: '*', value: 0.5 })] })

    show()

    const row = await project('paulo/app')
    expect(await row.findByText(en.floor.projects.noMetrics)).toBeDefined()
    expect(screen.queryByText('50%')).toBeNull()
    expect(screen.getAllByRole('rowheader')).toHaveLength(1)
  })

  it('adds up what a role cost over every tool that did it', async () => {
    serve({
      groups: [
        group({ harness: 'claude-code', runs: 2, costUsd: 1, avgDurationMs: 30_000 }),
        group({ harness: 'codex', runs: 2, costUsd: 2, avgDurationMs: 30_000 }),
      ],
    })

    show()

    const bar = await screen.findByRole('progressbar', { name: 'builder $3.00' })
    const row = within(bar.closest('li')!)
    expect(row.getByText('$3.00 · 4 passes · 30s')).toBeDefined()
    expect(row.getByRole('img', { name: 'Claude Code' })).toBeDefined()
    expect(row.getByRole('img', { name: 'Codex' })).toBeDefined()
  })

  it('says an average pass of a minute or more in minutes', async () => {
    serve({ groups: [group({ runs: 1, costUsd: 1, avgDurationMs: 150_000 })] })

    show()

    expect(await screen.findByText('$1.00 · 1 passes · 2m')).toBeDefined()
  })

  it('counts the passes that reported no cost', async () => {
    serve({ groups: [group({ runs: 3, reportedRuns: 1, costUsd: 1 })] })

    show()

    expect(
      await screen.findByText('$1.00 · 3 passes · 30s · 2 with no cost reported'),
    ).toBeDefined()
  })

  it('shows a role that never ran with no time', async () => {
    serve({ groups: [group({ role: 'lens', runs: 0, reportedRuns: 0, costUsd: 0 })] })

    show()

    expect(await screen.findByText('$0.00 · 0 passes · 0s')).toBeDefined()
    expect(screen.getByText('lens')).toBeDefined()
  })

  it('lists the role that cost the most first', async () => {
    serve({
      groups: [
        group({ role: 'reviewer', costUsd: 1 }),
        group({ role: 'builder', costUsd: 5 }),
        group({ role: 'planner', costUsd: 3 }),
      ],
    })

    show()

    await screen.findByRole('progressbar', { name: 'builder $5.00' })
    const names = screen.getAllByRole('progressbar').map((bar) => bar.getAttribute('aria-label'))
    expect(names).toEqual(['builder $5.00', 'planner $3.00', 'reviewer $1.00'])
  })
})

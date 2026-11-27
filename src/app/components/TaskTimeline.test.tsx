// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Stage, TimelineEvent } from '../../shared/panel'
import { CopyProvider } from '../lib/copy'
import { en } from '../lib/copy/en'
import { TaskTimeline } from './TaskTimeline'

afterEach(cleanup)

const at = (day: number, hour: number, minute: number) =>
  new Date(2026, 10, day, hour, minute).toISOString()
const ev = (id: number, stage: Stage, when: string): TimelineEvent => ({
  id,
  stage,
  at: when,
  detail: null,
})
const show = (events: TimelineEvent[], now: string) =>
  render(
    <CopyProvider>
      <TaskTimeline events={events} now={Date.parse(now)} />
    </CopyProvider>,
  )
const c = en.task.timelineView

describe('the timeline of a task', () => {
  it('lists the stages oldest first, each with its name and how long the task stayed', () => {
    show(
      [
        ev(2, 'build', at(27, 10, 5)),
        ev(1, 'intake', at(27, 10, 0)),
        ev(3, 'released', at(27, 10, 35)),
      ],
      at(27, 12, 0),
    )

    const steps = within(screen.getByRole('list', { name: en.task.timeline })).getAllByRole(
      'listitem',
    )
    expect(steps.map((s) => s.getAttribute('data-stage'))).toEqual(['intake', 'build', 'released'])
    expect(steps[0]?.textContent).toContain(en.stages.intake)
    expect(steps[0]?.textContent).toContain('5m')
    expect(steps[1]?.textContent).toContain('30m')
    // A task that ended counts no time after it.
    expect(steps[2]?.textContent).not.toMatch(/\d+[smhd]\b/)
  })

  it('says the time of the stage the task is in runs still', () => {
    show([ev(1, 'intake', at(27, 10, 0)), ev(2, 'build', at(27, 10, 5))], at(27, 10, 25))

    expect(screen.getByText(c.sofar('20m'))).toBeDefined()
  })

  it('splits the time by who had the task, with the share of each', () => {
    show(
      [
        ev(1, 'intake', at(27, 10, 0)),
        ev(2, 'build', at(27, 10, 10)),
        ev(3, 'handoff', at(27, 10, 40)),
        ev(4, 'released', at(27, 11, 40)),
      ],
      at(27, 12, 0),
    )

    const bar = screen.getByRole('img', {
      name: `${c.groups.queue} 10m, ${c.groups.agent} 30m, ${c.groups.person} 1h`,
    })
    const widths = [...bar.querySelectorAll<HTMLElement>('[data-group]')].map((g) => [
      g.dataset.group,
      g.style.width,
    ])
    expect(widths).toEqual([
      ['queue', '10%'],
      ['agent', '30%'],
      ['person', '60%'],
    ])
    expect(screen.getByText('60%')).toBeDefined()
  })

  it('starts a new day with a heading', () => {
    show([ev(1, 'intake', at(26, 23, 0)), ev(2, 'build', at(27, 1, 0))], at(27, 2, 0))

    const day = new Intl.DateTimeFormat('en', { weekday: 'short', day: 'numeric', month: 'short' })
    expect(screen.getByText(day.format(new Date(at(26, 23, 0))))).toBeDefined()
    expect(screen.getByText(day.format(new Date(at(27, 1, 0))))).toBeDefined()
  })

  it('shows no bar for a task with no event', () => {
    show([], at(27, 10, 0))

    expect(screen.queryByText(c.where)).toBeNull()
  })
})

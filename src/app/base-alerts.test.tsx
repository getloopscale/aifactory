// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { TaskCard } from '../shared/panel'

import { BaseAlerts } from './components/BaseAlerts'

afterEach(cleanup)

const held = (repository: string, since: string) =>
  ({
    repository,
    waitingOnBase: { branch: 'workspace', checks: ['CI'], since },
  }) as TaskCard

describe('the alert for a red integration branch at the top of the board', () => {
  it('names the branch, how long it has been red and the delivered tasks it holds', () => {
    render(
      <BaseAlerts
        now={new Date('2026-11-18T21:00:00Z')}
        tasks={[
          held('usetheokit/theokit', '2026-11-18T16:00:00Z'),
          held('usetheokit/theokit', '2026-11-18T20:00:00Z'),
        ]}
      />,
    )

    expect(screen.getByRole('alert').textContent).toBe(
      'usetheokit/theokit: workspace has been red for 5h on CI, holding 2 delivered tasks.',
    )
  })

  it('shows nothing while no task waits on its base', () => {
    render(<BaseAlerts tasks={[{ repository: 'o/a', waitingOnBase: null } as TaskCard]} />)

    expect(screen.queryByRole('alert')).toBeNull()
  })
})

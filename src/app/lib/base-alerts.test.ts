import { describe, expect, it } from 'vitest'

import { baseAlerts } from './base-alerts'

const NOW = new Date('2026-11-18T21:00:00Z')

const card = (
  repository: string,
  waitingOnBase: { branch: string; checks: string[]; since: string } | null,
) => ({ repository, waitingOnBase })

describe('baseAlerts', () => {
  it('gives one alert per red integration branch, from its oldest hold, with the tasks it holds', () => {
    const alerts = baseAlerts(
      [
        card('o/a', { branch: 'workspace', checks: ['CI'], since: '2026-11-18T19:00:00Z' }),
        card('o/a', { branch: 'workspace', checks: ['CI', 'lint'], since: '2026-11-18T16:00:00Z' }),
        card('o/b', null),
      ],
      NOW,
    )

    expect(alerts).toEqual([
      { repository: 'o/a', branch: 'workspace', checks: ['CI', 'lint'], held: 2, minutes: 300 },
    ])
  })

  it('puts the branch that has been red longest first', () => {
    const alerts = baseAlerts(
      [
        card('o/new', { branch: 'workspace', checks: ['CI'], since: '2026-11-18T20:50:00Z' }),
        card('o/old', { branch: 'workspace', checks: ['CI'], since: '2026-11-18T18:00:00Z' }),
      ],
      NOW,
    )

    expect(alerts.map((a) => a.repository)).toEqual(['o/old', 'o/new'])
  })

  it('gives nothing when no task waits on its base', () => {
    expect(baseAlerts([card('o/a', null)], NOW)).toEqual([])
  })
})

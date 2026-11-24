import { describe, expect, it } from 'vitest'

import { GUIDE_IDS } from '../../../shared/guides'
import { changePlanPrompt, givenPlanPrompt } from '../../factory/change-plan'
import { buildPrompt } from '../../factory/harness'
import { planPrompt } from '../../factory/plan'
import { resolvedPrompt, reviewPrompt } from '../../factory/review'
import { GUIDE_INSTRUCTIONS } from './guides'
import { PERSONA_ROLES, PERSONAS, personaPreamble } from './personas'
import { READINESS_INSTRUCTIONS } from './readiness'
import { SCOPE_INSTRUCTIONS } from './scope'

const issue = { repo: 'o/r', issueNumber: 1, title: 'T', body: 'B', branch: 'factory/1' }

describe('personas', () => {
  it.each(PERSONA_ROLES)('gives the %s a name, a job, limits and a voice', (role) => {
    const p = PERSONAS[role]
    expect(p.name).not.toBe('')
    expect(p.job).not.toBe('')
    expect(p.never.length).toBeGreaterThan(0)
    expect(p.voice).not.toBe('')
    expect(personaPreamble(role)).toContain(p.name)
  })

  it('has distinct names', () => {
    const names = PERSONA_ROLES.map((r) => PERSONAS[r].name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('opens every prompt of a role with the preamble of the role', () => {
    const plan = { files: [], order: [], risks: [], proof: [], outOfScope: [] }
    const starts: [string, string][] = [
      ['builder', buildPrompt(issue)],
      ['builder', givenPlanPrompt(issue, plan, 'codex')],
      ['planner', changePlanPrompt(issue)],
      ['planner', planPrompt({ repo: 'o/r', goal: 'g' })],
      ['reviewer', reviewPrompt({ ...issue, baseSha: 'abc' })],
      ['reviewer', resolvedPrompt({ ...issue, baseSha: 'abc', claim: 'c' })],
      ['coordinator', SCOPE_INSTRUCTIONS],
      ['coordinator', READINESS_INSTRUCTIONS],
      ...GUIDE_IDS.map((id): [string, string] => ['guide', GUIDE_INSTRUCTIONS(id)]),
    ]
    for (const [role, prompt] of starts) {
      expect(prompt.startsWith(personaPreamble(role as (typeof PERSONA_ROLES)[number]))).toBe(true)
    }
  })
})

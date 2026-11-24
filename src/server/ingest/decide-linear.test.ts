import { describe, expect, it } from 'vitest'

import { decideIngress } from './decide'
import { LINEAR_EVENT } from './decide-linear'

const settings = { labelId: 'L1', teams: { T1: 'o/r' } }
const issue = (extra = {}) => ({
  action: 'create',
  type: 'Issue',
  data: { id: 'i1', identifier: 'ENG-1', title: 't', teamId: 'T1', labelIds: ['L1'] },
  ...extra,
})

describe('decideIngress for a Linear delivery', () => {
  it('takes a labelled item of a mapped team', () => {
    expect(decideIngress(LINEAR_EVENT, issue(), settings)).toMatchObject({
      accept: true,
      repository: 'o/r',
    })
  })
  it('ignores an item without the label, an unmapped team and a plain update', () => {
    const bare = issue({ data: { id: 'i', title: 't', teamId: 'T1', labelIds: [] } })
    expect(decideIngress(LINEAR_EVENT, bare, settings)).toMatchObject({ code: 'label_not_factory' })
    const other = issue({ data: { id: 'i', title: 't', teamId: 'T9', labelIds: ['L1'] } })
    expect(decideIngress(LINEAR_EVENT, other, settings)).toMatchObject({ code: 'team_not_mapped' })
    expect(
      decideIngress(
        LINEAR_EVENT,
        issue({ action: 'update', updatedFrom: { labelIds: ['L1'] } }),
        settings,
      ),
    ).toMatchObject({ code: 'action_not_relevant' })
    expect(
      decideIngress(
        LINEAR_EVENT,
        issue({ action: 'update', updatedFrom: { labelIds: [] } }),
        settings,
      ),
    ).toMatchObject({ accept: true })
  })
  it('refuses a payload it cannot read', () => {
    expect(decideIngress(LINEAR_EVENT, {}, settings)).toMatchObject({ code: 'payload_invalid' })
  })
})

describe('decideIngress for Linear, more', () => {
  it('takes nothing while no label is configured, and ignores prototype keys as teams', () => {
    expect(decideIngress(LINEAR_EVENT, issue(), undefined)).toMatchObject({ accept: false })
    const proto = issue({ data: { id: 'i', title: 't', teamId: 'constructor', labelIds: ['L1'] } })
    expect(decideIngress(LINEAR_EVENT, proto, settings)).toMatchObject({ code: 'team_not_mapped' })
  })
  it('names the item, so the task is keyed by it and not by a number', () => {
    expect(decideIngress(LINEAR_EVENT, issue(), settings)).toMatchObject({
      accept: true,
      linear: { itemId: 'i1', display: 'ENG-1' },
    })
  })
})

describe('decideIngress for a Linear item that changes', () => {
  const routedOf = (extra: object, labelIds = ['L1']) =>
    decideIngress(
      LINEAR_EVENT,
      issue({
        action: 'update',
        data: { id: 'i1', title: 't', teamId: 'T1', labelIds, state: { type: 'completed' } },
        ...extra,
      }),
      settings,
    )

  it('routes an item that lost the label to its cancellation', () => {
    expect(routedOf({ updatedFrom: { labelIds: ['L1'] } }, [])).toMatchObject({
      accept: false,
      code: 'issue_unlabeled',
      intent: { linearItemId: 'i1', repository: 'o/r' },
    })
  })
  it('routes done, cancelled and removed items as closed', () => {
    expect(routedOf({ updatedFrom: { stateId: 's' } })).toMatchObject({ code: 'issue_closed' })
    expect(routedOf({ action: 'remove' }, [])).toMatchObject({ code: 'issue_closed' })
  })
  it('routes an item that left a finished state as reopened', () => {
    const open = issue({
      action: 'update',
      data: { id: 'i1', title: 't', teamId: 'T1', labelIds: ['L1'], state: { type: 'started' } },
      updatedFrom: { stateId: 's', completedAt: '2026-01-01' },
    })
    expect(decideIngress(LINEAR_EVENT, open, settings)).toMatchObject({ code: 'issue_reopened' })
  })
})

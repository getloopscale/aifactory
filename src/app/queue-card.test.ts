import { describe, expect, it } from 'vitest'

import type { QueueView } from '../shared/panel'

import { queueWords } from './components/Board'
import { en } from './lib/copy/en'
import { ptBR } from './lib/copy/pt-BR'

const view = (over: Partial<QueueView> = {}): QueueView => ({
  position: 3,
  reasons: { priority: 2, bug: true, unblocks: 4 },
  readiness: null,
  ...over,
})

describe('what a queued card says of its place', () => {
  it('names its place and every reason the scheduler had but the priority, which has a badge of its own', () => {
    expect(queueWords(view(), en.board)).toEqual({
      place: '#3 in the queue · bug · unblocks 4',
      verdict: null,
    })
  })

  it('leaves out a reason that does not apply', () => {
    const reasons = { priority: null, bug: false, unblocks: 0 }
    expect(queueWords(view({ reasons }), en.board).place).toBe('#3 in the queue')
  })

  it('says only the place before the scheduler placed the task', () => {
    expect(queueWords(view({ reasons: null }), en.board).place).toBe('#3 in the queue')
  })

  it('says the run is held when it is not in the line', () => {
    expect(queueWords(view({ position: null, reasons: null }), en.board).place).toBe(
      'held in the queue',
    )
  })

  it('gives the readiness verdict with what the issue is missing', () => {
    const missing = { verdict: 'needs_refinement' as const, missing: 'no acceptance criterion' }
    expect(queueWords(view({ readiness: missing }), en.board).verdict).toBe(
      'needs refinement: no acceptance criterion',
    )
    expect(queueWords(view({ readiness: { ...missing, missing: '' } }), en.board).verdict).toBe(
      'needs refinement',
    )
    expect(
      queueWords(
        view({ readiness: { verdict: 'blocked', missing: 'a file under .github/' } }),
        en.board,
      ).verdict,
    ).toBe('blocked: a file under .github/')
    expect(
      queueWords(view({ readiness: { verdict: 'ready', missing: '' } }), en.board).verdict,
    ).toBe('ready to build')
  })

  it('says it in pt-BR too', () => {
    expect(
      queueWords(
        view({ readiness: { verdict: 'needs_refinement', missing: 'sem critério' } }),
        ptBR.board,
      ),
    ).toEqual({
      place: '3ª na fila · bug · desbloqueia 4',
      verdict: 'precisa de refinamento: sem critério',
    })
  })
})

// @vitest-environment jsdom
import { cleanup, render as rtlRender, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import type { TaskDetail, TranscriptEvent } from '../../shared/panel'
import { CopyProvider, LANGUAGE_KEY } from '../lib/copy'
import { en } from '../lib/copy/en'

import { Conversation } from './Conversation'

window.localStorage.setItem(LANGUAGE_KEY, 'en')
afterEach(cleanup)
const render = (ui: ReactElement) =>
  rtlRender(<MemoryRouter>{ui}</MemoryRouter>, { wrapper: CopyProvider })

const step = (seq: number, role: TranscriptEvent['role'], content: string): TranscriptEvent => ({
  seq,
  role,
  attempt: 1,
  kind: 'message',
  tool: null,
  content,
  at: `2026-11-25T10:0${seq}:00Z`,
})
const events = [
  step(1, 'builder', 'built it'),
  step(2, 'builder', 'built more'),
  step(3, 'reviewer', 'reviewed it'),
  step(4, 'reviewer', 'looks fine'),
]
const run = (id: number, role: string, range: [number, number] | null) => ({
  id,
  role,
  harness: 'claude',
  model: null,
  effort: null,
  tokensIn: null,
  tokensOut: null,
  attempt: 1,
  costUsd: null,
  durationMs: 1,
  ok: true,
  quota: false,
  eventFrom: range?.[0] ?? null,
  eventTo: range?.[1] ?? null,
  at: '2026-11-25T10:00:00Z',
})
const detail = {
  task: { id: 5, stage: 'done', repository: 'o/r', title: 'T', issueNumber: 1 },
  messages: [],
  runs: [run(10, 'builder', [1, 2]), run(11, 'reviewer', [3, 4]), run(12, 'reviewer', null)],
} as unknown as TaskDetail

describe('opening the conversation at a pass', () => {
  it("picks the pass's tab and marks the steps it wrote", () => {
    const { container } = render(
      <Conversation detail={detail} events={events} onDone={() => {}} focusRun={11} />,
    )
    const tabs = screen.getAllByRole('tab')
    expect(tabs.find((t) => t.getAttribute('aria-selected') === 'true')?.textContent).toBe(
      en.transcript.reviewer,
    )
    const marked = container.querySelector('[data-focus="true"]')
    expect(marked?.textContent).toContain('reviewed it')
    expect(screen.queryByText(en.conversation.passMissing)).toBeNull()
  })

  it('says so for a pass recorded without a range, and still opens its tab', () => {
    const { container } = render(
      <Conversation detail={detail} events={events} onDone={() => {}} focusRun={12} />,
    )
    expect(screen.getByText(en.conversation.passMissing)).toBeTruthy()
    expect(container.querySelector('[data-focus="true"]')).toBeNull()
    expect(
      screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true')
        ?.textContent,
    ).toBe(en.transcript.reviewer)
  })

  it('says so when the pass is unknown, and marks nothing without a focus', () => {
    const missing = render(
      <Conversation detail={detail} events={events} onDone={() => {}} focusRun={99} />,
    )
    expect(screen.getByText(en.conversation.passMissing)).toBeTruthy()
    missing.unmount()
    const plain = render(<Conversation detail={detail} events={events} onDone={() => {}} />)
    expect(plain.container.querySelector('[data-focus="true"]')).toBeNull()
    expect(screen.queryByText(en.conversation.passMissing)).toBeNull()
  })
})

describe('the mode the box offers', () => {
  const modes = () =>
    Array.from(screen.getByLabelText(en.conversation.mode).querySelectorAll('option')).map(
      (o) => o.getAttribute('value'),
    )
  it('offers guide where the server takes it', () => {
    render(<Conversation detail={{ ...detail, guide: { available: true } }} onDone={() => {}} />)
    expect(modes()).toEqual(['ask', 'guide'])
  })
  it('offers only ask, with the reason, where the server refuses guide', () => {
    const refused = { ...detail, guide: { available: false, reason: 'not here' } }
    render(<Conversation detail={refused} onDone={() => {}} />)
    expect(modes()).toEqual(['ask'])
    expect(screen.getByText('not here')).toBeTruthy()
  })
})

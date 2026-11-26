// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TaskCard, TaskDiff } from '../../shared/panel'

import { Changes } from './Changes'

vi.mock('theokit/client', () => ({
  useAgent: () => ({ thread: [], status: 'idle', error: undefined, send: vi.fn(), reset: vi.fn() }),
}))

const task = { id: 7, repository: 'o/r', issueNumber: 3, title: 'Add a thing' } as TaskCard

const PATCH = ['@@ -1,2 +1,3 @@', ' first', '-old', '+new', '+newer'].join('\n')
const READY: TaskDiff = {
  state: 'ready',
  pullRequestUrl: 'https://github.com/o/r/pull/12',
  truncated: false,
  files: [
    { path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, patch: PATCH },
    { path: 'logo.png', status: 'added', additions: 0, deletions: 0 },
  ],
}

type Sent = { url: string; body: unknown }
let sent: Sent[]

/** Answers the diff read with `diff`, and records every send-back, which `changes` answers. */
function serve(diff: () => Response, changes: () => Response = () => Response.json({})) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (String(url).endsWith('/diff')) return diff()
      sent.push({ url: String(url), body: JSON.parse(String(init.body)) })
      return changes()
    }),
  )
}

const mount = (over: Partial<Parameters<typeof Changes>[0]> = {}) => {
  const onDone = vi.fn()
  render(<Changes task={task} active canSendBack onDone={onDone} {...over} />)
  return onDone
}

/** Writes a note on a line of the new version and keeps it. */
async function note(line: number, body: string) {
  fireEvent.click(await screen.findByRole('button', { name: `Add a note on line ${line}` }))
  const box = screen.getByRole('textbox', { name: `Add a note on line ${line}` })
  fireEvent.change(box, { target: { value: body } })
  fireEvent.click(screen.getByRole('button', { name: 'Add note' }))
}

beforeEach(() => {
  sent = []
  localStorage.clear()
  vi.stubGlobal('EventSource', undefined)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the change of a task', () => {
  it('asks GitHub for nothing until the owner looks', async () => {
    serve(() => Response.json(READY))

    mount({ active: false })

    expect(fetch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Show the changes' }))
    expect(await screen.findByText('src/a.ts')).toBeTruthy()
  })

  it('shows each file with its lines, numbered on the side they belong to', async () => {
    serve(() => Response.json(READY))

    mount()

    const file = await screen.findByRole('region', { name: 'src/a.ts' })
    expect(within(file).getByText('+2 -1')).toBeTruthy()
    const kinds = [...file.querySelectorAll('[data-line]')].map((l) => l.getAttribute('data-line'))
    expect(kinds).toEqual(['meta', 'context', 'del', 'add', 'add'])
    // A removed line is not in the new version, so it takes no note.
    expect(within(file).getAllByRole('button', { name: /Add a note on line/ })).toHaveLength(3)
  })

  it('says a file without a patch has no text to show, never an empty change', async () => {
    serve(() => Response.json(READY))

    mount()

    const file = await screen.findByRole('region', { name: 'logo.png' })
    expect(within(file).getByText(/binary or too large/)).toBeTruthy()
  })

  it('says the task has no pull request', async () => {
    serve(() => Response.json({ state: 'no_pull_request' }))

    mount()

    expect(await screen.findByText(/has no pull request yet/)).toBeTruthy()
  })

  it('says the listing was cut short', async () => {
    serve(() => Response.json({ ...READY, truncated: true }))

    mount()

    expect(await screen.findByText(/Showing the first 2 files/)).toBeTruthy()
  })

  it('shows what GitHub answered and offers to try again', async () => {
    let fails = true
    serve(() =>
      fails
        ? Response.json({ message: 'GitHub answered 502' }, { status: 502 })
        : Response.json(READY),
    )

    mount()

    expect((await screen.findByRole('alert')).textContent).toContain('GitHub answered 502')
    fails = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('src/a.ts')).toBeTruthy()
  })
})

describe('notes on the lines of a change', () => {
  it('are sent together as one send-back, with the text the owner read', async () => {
    serve(() => Response.json(READY))
    const onDone = mount()
    await note(3, 'use the helper')
    await note(2, 'rename this')

    fireEvent.click(screen.getByRole('button', { name: 'Review and send' }))
    const text = screen.getByRole('textbox', { name: /What the agent will receive/ })
    expect((text as HTMLTextAreaElement).value).toBe(
      'Notes on lines of the change, one per line named:\n\n' +
        'File: src/a.ts\nLine: 2\nNote: "rename this"\n\n' +
        'File: src/a.ts\nLine: 3\nNote: "use the helper"',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Send back' }))

    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(sent).toEqual([
      { url: '/api/panel/tasks/7/changes', body: { note: (text as HTMLTextAreaElement).value } },
    ])
    expect(screen.queryByRole('region', { name: /notes?$/ })).toBeNull()
    expect(localStorage.getItem('review-notes:7')).toBeNull()
  })

  it('sends the text as the owner edited it', async () => {
    serve(() => Response.json(READY))
    mount()
    await note(2, 'rename this')

    fireEvent.click(screen.getByRole('button', { name: 'Review and send' }))
    fireEvent.change(screen.getByRole('textbox', { name: /What the agent will receive/ }), {
      target: { value: 'only this' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send back' }))

    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].body).toEqual({ note: 'only this' })
  })

  it('stay when the server refuses the send-back, with the reason', async () => {
    serve(
      () => Response.json(READY),
      () => Response.json({ message: 'the task is running' }, { status: 409 }),
    )
    const onDone = mount()
    await note(2, 'rename this')

    fireEvent.click(screen.getByRole('button', { name: 'Review and send' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send back' }))

    expect(await screen.findByText('the task is running')).toBeTruthy()
    expect(onDone).not.toHaveBeenCalled()
    expect(screen.getByRole('region', { name: '1 note' })).toBeTruthy()
  })

  it('survive leaving the page', async () => {
    serve(() => Response.json(READY))
    mount()
    await note(2, 'rename this')
    cleanup()

    mount()

    expect(await screen.findByRole('region', { name: '1 note' })).toBeTruthy()
  })

  it('wait, with the reason, for a task that cannot be sent back', async () => {
    serve(() => Response.json(READY))
    mount({ canSendBack: false })
    await note(2, 'rename this')

    const send = screen.getByRole('button', { name: 'Review and send' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    expect(send.getAttribute('aria-description')).toMatch(/cannot be sent back now/)
    expect(screen.getByText(/cannot be sent back now/)).toBeTruthy()
  })

  it('refuse a text longer than a send-back takes', async () => {
    serve(() => Response.json(READY))
    mount()
    await note(2, 'rename this')

    fireEvent.click(screen.getByRole('button', { name: 'Review and send' }))
    fireEvent.change(screen.getByRole('textbox', { name: /What the agent will receive/ }), {
      target: { value: 'x'.repeat(4003) },
    })

    expect(screen.getByRole('alert').textContent).toContain('3 characters over the limit')
    expect((screen.getByRole('button', { name: 'Send back' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('keep a draft with text in it when another line is pressed', async () => {
    serve(() => Response.json(READY))
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Add a note on line 2' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Add a note on line 2' }), {
      target: { value: 'half written' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Add a note on line 3' }))

    expect(
      (screen.getByRole('textbox', { name: 'Add a note on line 2' }) as HTMLTextAreaElement).value,
    ).toBe('half written')
  })

  it('are kept by Enter, and Shift+Enter only breaks the line', async () => {
    serve(() => Response.json(READY))
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Add a note on line 2' }))
    const box = screen.getByRole('textbox', { name: 'Add a note on line 2' })
    fireEvent.change(box, { target: { value: 'rename this' } })

    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(screen.queryByRole('region', { name: '1 note' })).toBeNull()

    fireEvent.keyDown(box, { key: 'Enter' })
    expect(screen.getByRole('region', { name: '1 note' })).toBeTruthy()
  })

  it('go one at a time, by the button on each', async () => {
    serve(() => Response.json(READY))
    mount()
    await note(2, 'rename this')
    await note(3, 'use the helper')

    const shelf = screen.getByRole('region', { name: '2 notes' })
    fireEvent.click(
      within(shelf).getByRole('button', { name: 'Delete the note on src/a.ts line 2' }),
    )

    expect(screen.getByRole('region', { name: '1 note' })).toBeTruthy()
    expect(JSON.parse(localStorage.getItem('review-notes:7') ?? '[]')).toHaveLength(1)
  })
})

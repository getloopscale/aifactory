import { describe, expect, it, vi } from 'vitest'

import type { CodeEvent } from '../../shared/code'
import type { ActivePass } from '../factory/harness'

import { watchControls, type ControlStore } from './live-conversation'

const message = (seq: number, content = `m${seq}`): CodeEvent => ({
  sessionId: 's',
  seq,
  kind: 'user_message',
  tool: null,
  content,
  at: new Date(),
})

function world() {
  const state = { stop: false, pending: [] as CodeEvent[], appended: [] as string[] }
  const store: ControlStore = {
    stopRequested: async () => state.stop,
    pending: async () => state.pending.find((m) => !state.appended.includes(`turn:${m.seq}`)),
    append: async (_id, event) => {
      state.appended.push(event.content)
    },
  }
  return { state, store }
}

const pass = (over: Partial<ActivePass> = {}): ActivePass & { sent: string[]; cancels: number } => {
  const p = {
    sent: [] as string[],
    cancels: 0,
    interrupts: false,
    send: async (text: string) => {
      p.sent.push(text)
      return 'delivered' as const
    },
    cancel: async () => {
      p.cancels += 1
    },
    ...over,
  }
  return p
}

describe('watchControls', () => {
  it('hands a pending message to the pass once and marks it answered', async () => {
    const { state, store } = world()
    state.pending.push(message(2))
    const watch = watchControls(store, 's', 5)
    const p = pass()
    watch.live.attach(p)
    await vi.waitFor(() => expect(state.appended).toEqual(['turn:2']))
    await new Promise((r) => setTimeout(r, 30))
    await watch.end()
    expect(p.sent).toEqual(['m2'])
  })

  it('takes no message before a pass is attached', async () => {
    const { state, store } = world()
    state.pending.push(message(2))
    const watch = watchControls(store, 's', 5)
    await new Promise((r) => setTimeout(r, 30))
    await watch.end()
    expect(state.appended).toEqual([])
  })

  it('leaves the message unanswered when the pass is already over', async () => {
    const { state, store } = world()
    state.pending.push(message(2))
    const watch = watchControls(store, 's', 5)
    const p = pass({ send: async () => 'ended' })
    watch.live.attach(p)
    await new Promise((r) => setTimeout(r, 30))
    await watch.end()
    expect(state.appended).toEqual([])
  })

  it('leaves the message unanswered when sending throws, and tries again', async () => {
    const { state, store } = world()
    state.pending.push(message(2))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let calls = 0
    const watch = watchControls(store, 's', 5)
    watch.live.attach(
      pass({
        send: async () => {
          calls += 1
          if (calls === 1) throw new Error('no inbox')
          return 'delivered'
        },
      }),
    )
    await vi.waitFor(() => expect(state.appended).toEqual(['turn:2']))
    await watch.end()
    expect(calls).toBe(2)
    warn.mockRestore()
  })

  it('cancels the attached pass when a stop is asked, and keeps asking until the pass settles', async () => {
    const { state, store } = world()
    const watch = watchControls(store, 's', 5)
    const p = pass()
    watch.live.attach(p)
    state.stop = true
    await watch.stopped
    await vi.waitFor(() => expect(p.cancels).toBeGreaterThanOrEqual(2))
    await watch.end()
    const after = p.cancels
    await new Promise((r) => setTimeout(r, 30))
    expect(p.cancels).toBe(after)
  })

  it('cancels a pass that attaches after the stop was asked', async () => {
    const { state, store } = world()
    state.stop = true
    const watch = watchControls(store, 's', 5)
    await watch.stopped
    const p = pass()
    watch.live.attach(p)
    await vi.waitFor(() => expect(p.cancels).toBeGreaterThanOrEqual(1))
    await watch.end()
  })

  it('delivers no message once a stop was asked', async () => {
    const { state, store } = world()
    state.stop = true
    state.pending.push(message(2))
    const watch = watchControls(store, 's', 5)
    const p = pass()
    watch.live.attach(p)
    await watch.stopped
    await new Promise((r) => setTimeout(r, 30))
    await watch.end()
    expect(p.sent).toEqual([])
  })

  it('waits for a tick in flight when it ends', async () => {
    const { state, store } = world()
    state.pending.push(message(2))
    let release!: () => void
    const watch = watchControls(store, 's', 5)
    watch.live.attach(
      pass({
        send: () =>
          new Promise((resolve) => {
            release = () => resolve('delivered')
          }),
      }),
    )
    await vi.waitFor(() => expect(release).toBeDefined())
    let ended = false
    const end = watch.end().then(() => (ended = true))
    await new Promise((r) => setTimeout(r, 20))
    expect(ended).toBe(false)
    release()
    await end
    expect(state.appended).toEqual(['turn:2'])
  })
})

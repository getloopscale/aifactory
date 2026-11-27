import { spawn } from 'node:child_process'
import { once } from 'node:events'

import { describe, expect, it } from 'vitest'

import { identityOf, processStart, THIS_PROCESS } from './sandbox-lease'
import type { Database } from '../db'
import { codeSession } from '../db/schema'

import { processState, readReaperFacts } from './sandbox-reaper-facts'

const lease = { host: 'here', pid: 42, started: '100' }

describe('processState', () => {
  it('cannot tell for a process on another host', () => {
    expect(processState(lease, { here: 'there', startOf: () => '100' })).toBe('unknown')
  })

  it('is alive while the process id runs since the start the lease recorded', () => {
    expect(processState(lease, { here: 'here', startOf: () => '100' })).toBe('alive')
  })

  it('is gone when the process id is not running, or runs since another start', () => {
    expect(processState(lease, { here: 'here', startOf: () => null })).toBe('gone')
    expect(processState(lease, { here: 'here', startOf: () => '999' })).toBe('gone')
  })

  it('asks whether the id runs when the system recorded no start', () => {
    const bare = { ...lease, started: null }
    expect(processState(bare, { here: 'here', runs: () => true })).toBe('alive')
    expect(processState(bare, { here: 'here', runs: () => false })).toBe('gone')
  })

  it('sees this process alive and a killed child gone, on this host', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], {
      stdio: 'ignore',
    })
    await once(child, 'spawn')
    const identity = identityOf(child.pid!, 'child')
    expect(processState(identity)).toBe('alive')

    child.kill('SIGKILL')
    await once(child, 'exit')

    expect(processState(identity)).toBe('gone')
    expect(processState(THIS_PROCESS)).toBe('alive')
  })
})

describe('processStart', () => {
  it('reads the start time after a command name that holds spaces and parentheses', () => {
    const fields = Array.from({ length: 50 }, (_, i) => String(i + 3))
    const stat = `42 (a (b) c) ${fields.join(' ')}`
    expect(processStart(42, (() => stat) as never)).toBe('22')
  })

  it('is null for a process that does not exist', () => {
    const read = (() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }) as never
    expect(processStart(42, read)).toBeNull()
  })
})

describe('readReaperFacts', () => {
  const owned = (sessionId: string) => ({
    id: `sbx-${sessionId}`,
    startedAt: new Date(),
    metadata: { app: 'aifactory', owner: 'code', sessionId },
  })
  const dbWith = (sessions: { id: string; state: string }[]) =>
    ({
      select: () => ({
        from: (table: unknown) => ({
          where: async () => (table === codeSession ? sessions : []),
        }),
      }),
    }) as unknown as Database

  it('reads the session a code sandbox names, and nothing for one that is gone', async () => {
    const facts = await readReaperFacts(dbWith([{ id: 'here', state: 'ended' }]), [
      owned('here'),
      owned('gone'),
    ])
    expect(facts.codeSessions.get('here')).toEqual({ state: 'ended' })
    expect(facts.codeSessions.has('gone')).toBe(false)
  })
})

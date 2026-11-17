import { describe, expect, it } from 'vitest'

import { BaseProbe, sameChecks } from './base-checks'
import type { CheckResult } from './evidence'
import { FakeBackend } from './fake-sandbox'

const failing = (...names: string[]): CheckResult[] =>
  names.map((name) => ({
    name,
    command: `run ${name}`,
    exitCode: 1,
    timedOut: false,
    passed: false,
    output: '',
    durationMs: 1,
  }))

const run = {
  repoDir: '/work/work',
  baseSha: 'abc123def',
  checks: [
    { name: 'install', command: 'run install' },
    { name: 'lint', command: 'run lint' },
    { name: 'quality', command: 'run quality' },
  ],
  timeoutMs: 1000,
}

describe('sameChecks', () => {
  it('says the checks failed again when every failing check failed on the commit before', () => {
    expect(sameChecks(failing('quality'), failing('quality'))).toBe(true)
    expect(sameChecks(failing('lint', 'quality'), failing('quality'))).toBe(true)
  })

  it('says nothing failed again for a first failure, a new check, or no failure', () => {
    expect(sameChecks(undefined, failing('quality'))).toBe(false)
    expect(sameChecks(failing('lint'), failing('quality'))).toBe(false)
    expect(sameChecks(failing('lint'), failing('lint', 'quality'))).toBe(false)
    expect(sameChecks(failing('lint'), [])).toBe(false)
  })
})

describe('BaseProbe', () => {
  it('names the checks that fail on the base too, after the first check prepares it', async () => {
    const backend = new FakeBackend((c) =>
      c.endsWith('run quality') ? { exitCode: 1 } : undefined,
    )

    const red = await new BaseProbe().red(backend, run, failing('quality'))

    expect(red).toEqual(['quality'])
    const onBase = backend.commands.filter((c) => c.startsWith('cd /tmp/aifactory-base &&'))
    expect(onBase).toEqual([
      'cd /tmp/aifactory-base && run install',
      'cd /tmp/aifactory-base && run quality',
      'cd /tmp/aifactory-base && run quality',
    ])
  })

  it('answers nothing when one of the failing checks passes on the base', async () => {
    const backend = new FakeBackend((c) =>
      c.endsWith('run quality') ? { exitCode: 1 } : undefined,
    )

    expect(await new BaseProbe().red(backend, run, failing('lint', 'quality'))).toBeUndefined()
  })

  it('does not run on the base again a check that already passed there in this run', async () => {
    const backend = new FakeBackend(() => undefined)
    const probe = new BaseProbe()

    expect(await probe.red(backend, run, failing('lint'))).toBeUndefined()
    const before = backend.commands.length
    expect(await probe.red(backend, run, failing('lint', 'quality'))).toBeUndefined()

    expect(backend.commands.length).toBe(before)
  })
})

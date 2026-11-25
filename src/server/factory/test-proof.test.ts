import { describe, expect, it } from 'vitest'

import { FakeBackend, type Reply } from './fake-sandbox'
import {
  PROOF_DIR,
  PROOF_LIST,
  addsProofFinding,
  proveTests,
  testProofModeFromEnv,
  UNPROVEN_TESTS,
} from './test-proof'

const run = {
  repoDir: '/work/work',
  baseSha: 'base111',
  headSha: 'head222',
  checks: [
    { name: 'install', command: 'run install' },
    { name: 'test', command: 'run test' },
  ],
  timeoutMs: 1000,
}

const listing = (...paths: string[]) => ({ stdout: paths.map((p) => `${p}\0`).join('') })

function backendFor(files: string[], extra: (c: string) => Reply | undefined = () => undefined) {
  return new FakeBackend((c) => (c.includes(' diff -z ') ? listing(...files) : extra(c)))
}

describe('proveTests', () => {
  it('is proven, naming the check, when a check fails on the base with the head tests', async () => {
    const backend = backendFor(['src/a.ts', 'src/a.test.ts'], (c) =>
      c.endsWith('run test') ? { exitCode: 1 } : undefined,
    )
    const proof = await proveTests(backend, run)
    expect(proof).toEqual({ outcome: 'proven', detail: 'test', files: ['src/a.test.ts'] })
    expect(backend.files.get(PROOF_LIST)).toBe('src/a.test.ts\0')
    expect(backend.commands.some((c) => c.includes('--literal-pathspecs checkout head222'))).toBe(
      true,
    )
  })

  it('is unproven when every check passes on the base', async () => {
    const proof = await proveTests(backendFor(['a.test.ts']), run)
    expect(proof).toEqual({ outcome: 'unproven', files: ['a.test.ts'] })
  })

  it('is no_tests and starts no checkout when no test file changed', async () => {
    const backend = backendFor(['src/a.ts'])
    expect(await proveTests(backend, run)).toEqual({ outcome: 'no_tests', files: [] })
    expect(backend.commands.some((c) => c.includes('worktree add'))).toBe(false)
  })

  it('keeps a path with spaces out of the shell', async () => {
    const backend = backendFor(['a b/$(x).test.ts'])
    await proveTests(backend, run)
    expect(backend.files.get(PROOF_LIST)).toBe('a b/$(x).test.ts\0')
    expect(backend.commands.filter((c) => c.includes('$(x)'))).toEqual([])
  })

  it('is not_run, never proven, when the checkout fails, and still cleans up', async () => {
    const backend = backendFor(['a.test.ts'], (c) =>
      c.includes('worktree add') ? { exitCode: 128, stderr: 'no such commit' } : undefined,
    )
    const proof = await proveTests(backend, run)
    expect(proof.outcome).toBe('not_run')
    expect(proof.detail).toContain('no such commit')
    expect(backend.commands.some((c) => c.includes(`worktree remove --force ${PROOF_DIR}`))).toBe(
      true,
    )
  })

  it('is not_run when the copy fails', async () => {
    const backend = backendFor(['a.test.ts'], (c) =>
      c.includes('--pathspec-from-file') ? { exitCode: 1, stderr: 'did not match' } : undefined,
    )
    const proof = await proveTests(backend, run)
    expect(proof.outcome).toBe('not_run')
    expect(backend.commands.some((c) => c.includes('rm -rf /tmp/aifactory-proof'))).toBe(true)
  })

  it('is not_run, and cleans up, when a check is cut at its limit', async () => {
    const backend = backendFor(['a.test.ts'], (c) =>
      c.endsWith('run test') ? ({ exitCode: 124, timedOut: true } as Reply) : undefined,
    )
    const proof = await proveTests(backend, run)
    expect(proof).toMatchObject({ outcome: 'not_run', detail: 'check test was cut at its limit' })
    expect(backend.commands.some((c) => c.includes(`worktree remove --force ${PROOF_DIR}`))).toBe(
      true,
    )
  })

  it('is not_run when the changed files cannot be listed', async () => {
    const backend = new FakeBackend((c) => (c.includes(' diff -z ') ? { exitCode: 1 } : undefined))
    expect((await proveTests(backend, run)).outcome).toBe('not_run')
  })
})

describe('the finding and the mode', () => {
  const unproven = { outcome: 'unproven' as const, files: ['a.test.ts'] }

  it('adds a major finding only in auto and only for an unproven head', () => {
    expect(addsProofFinding('auto', unproven)).toEqual([
      { severity: 'major', file: 'a.test.ts', issue: UNPROVEN_TESTS },
    ])
    expect(addsProofFinding('trial', unproven)).toEqual([])
    expect(addsProofFinding('off', unproven)).toEqual([])
    expect(addsProofFinding('auto', { outcome: 'not_run', files: [] })).toEqual([])
    expect(addsProofFinding('auto', { outcome: 'no_tests', files: [] })).toEqual([])
    expect(addsProofFinding('auto', undefined)).toEqual([])
  })

  it('defaults to trial and refuses an unknown word', () => {
    expect(testProofModeFromEnv({})).toBe('trial')
    expect(testProofModeFromEnv({ FACTORY_TEST_PROOF_MODE: 'auto' })).toBe('auto')
    expect(() => testProofModeFromEnv({ FACTORY_TEST_PROOF_MODE: 'x' })).toThrow()
  })
})

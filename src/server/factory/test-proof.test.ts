import { describe, expect, it } from 'vitest'

import { FakeBackend, type Reply } from './fake-sandbox'
import {
  PROOF_DIR,
  PROOF_LIST,
  addsProofFinding,
  alongside,
  blockedByProof,
  provedOnce,
  proofChecks,
  runsNoTest,
  type ProofStore,
  type TestProof,
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

describe('the proof stops at its answer and runs only checks that can run a test (#716)', () => {
  const checksRun = (backend: FakeBackend) =>
    backend.commands.filter((c) => c.includes('run ')).map((c) => c.slice(c.indexOf('run ')))

  it('runs no check after the first that fails on the base, retried once as today', async () => {
    const backend = backendFor(['a.test.ts'], (c) =>
      c.endsWith('run unit') ? { exitCode: 1 } : undefined,
    )
    const proof = await proveTests(backend, {
      ...run,
      checks: [
        { name: 'install', command: 'run install' },
        { name: 'unit', command: 'run unit' },
        { name: 'e2e', command: 'run e2e' },
      ],
    })
    expect(proof).toEqual({ outcome: 'proven', detail: 'unit', files: ['a.test.ts'] })
    expect(checksRun(backend)).toEqual(['run install', 'run unit', 'run unit'])
    expect(backend.commands.some((c) => c.includes(`worktree remove --force ${PROOF_DIR}`))).toBe(
      true,
    )
  })

  it('goes on when the retry of a failed check passes', async () => {
    let unit = 0
    const backend = backendFor(['a.test.ts'], (c) =>
      c.endsWith('run unit') ? { exitCode: unit++ === 0 ? 1 : 0 } : undefined,
    )
    const proof = await proveTests(backend, {
      ...run,
      checks: [
        { name: 'unit', command: 'run unit' },
        { name: 'e2e', command: 'run e2e' },
      ],
    })
    expect(proof.outcome).toBe('unproven')
    expect(checksRun(backend)).toEqual(['run unit', 'run unit', 'run e2e'])
  })

  it('goes on after a check cut at its limit, and a later failure still proves', async () => {
    const backend = backendFor(['a.test.ts'], (c) =>
      c.endsWith('run unit')
        ? ({ exitCode: 124, timedOut: true } as Reply)
        : c.endsWith('run e2e')
          ? { exitCode: 1 }
          : undefined,
    )
    const checks = [
      { name: 'unit', command: 'run unit' },
      { name: 'e2e', command: 'run e2e' },
    ]
    expect(await proveTests(backend, { ...run, checks })).toMatchObject({
      outcome: 'proven',
      detail: 'e2e',
    })
  })

  it('does not stop at a failure while a later check has its name, since the last result is read', async () => {
    const backend = backendFor(['a.test.ts'], (c) =>
      c.endsWith('run first') ? { exitCode: 1 } : undefined,
    )
    const proof = await proveTests(backend, {
      ...run,
      checks: [
        { name: 'test', command: 'run first' },
        { name: 'test', command: 'run second' },
      ],
    })
    expect(proof.outcome).toBe('unproven')
    expect(checksRun(backend)).toContain('run second')
  })

  it('does not run on the base a check known to run no test', async () => {
    const backend = backendFor(['a.test.ts'])
    const proof = await proveTests(backend, {
      ...run,
      checks: [
        { name: 'install', command: 'corepack enable && pnpm install --frozen-lockfile' },
        { name: 'typecheck', command: 'pnpm typecheck' },
        { name: 'test', command: 'pnpm test' },
        { name: 'lint', command: 'pnpm lint' },
        { name: 'format', command: 'pnpm format:check' },
        { name: 'build', command: 'pnpm build' },
      ],
    })
    expect(proof.outcome).toBe('unproven')
    const ran = backend.commands.filter((c) => c.includes('pnpm '))
    expect(ran.some((c) => c.includes('pnpm install'))).toBe(true)
    expect(ran.some((c) => c.endsWith('pnpm test'))).toBe(true)
    for (const skipped of ['typecheck', 'lint', 'format:check', 'build']) {
      expect(ran.some((c) => c.endsWith(`pnpm ${skipped}`))).toBe(false)
    }
  })

  it('is not_run, never unproven, when no check left can run a test', async () => {
    const backend = backendFor(['a.test.ts'])
    const proof = await proveTests(backend, {
      ...run,
      checks: [
        { name: 'install', command: 'pnpm install' },
        { name: 'lint', command: 'pnpm lint' },
      ],
    })
    expect(proof).toEqual({
      outcome: 'not_run',
      detail: 'no check of the task runs tests',
      files: ['a.test.ts'],
    })
    expect(backend.commands.some((c) => c.includes('worktree add'))).toBe(false)
  })

  it('knows only plain formatting, linting, typechecking and build commands', () => {
    const known = [
      'pnpm lint',
      'npm run lint:fix',
      'yarn format',
      'pnpm format:check',
      'pnpm typecheck',
      'pnpm build',
      'bun run build:prod',
      'pnpm exec tsc --noEmit -p .',
      'npx prettier --check .',
      'eslint .',
      'tsc --noEmit',
      'node /tmp/factory-changeset-check.mjs develop',
    ]
    const unknown = [
      'pnpm test',
      'npm run test:unit',
      'pnpm build && pnpm test',
      'pnpm install --frozen-lockfile',
      'make check',
      'pnpm exec vitest run',
      'pnpm quality',
      'cargo build',
      'pnpm lint; pnpm test',
      'go test ./...',
    ]
    for (const command of known) expect(runsNoTest({ name: 'x', command }), command).toBe(true)
    for (const command of unknown) expect(runsNoTest({ name: 'x', command }), command).toBe(false)
    expect(
      proofChecks([
        { name: 'a', command: 'pnpm lint' },
        { name: 'b', command: 'pnpm test' },
      ]).map((c) => c.name),
    ).toEqual(['b'])
  })
})

describe('alongside', () => {
  it('runs the work without waiting for the background', async () => {
    let release = () => {}
    const background = new Promise<void>((resolve) => (release = resolve))
    const order: string[] = []
    const done = alongside(background, async () => (order.push('work'), 'read'))
    expect(await done).toBe('read')
    expect(order).toEqual(['work'])
    release()
  })

  it('lets the background settle before a failure of the work goes on', async () => {
    let settled = false
    const background = new Promise<void>((resolve) =>
      setTimeout(() => ((settled = true), resolve()), 5),
    )
    await expect(
      alongside(background, async () => {
        throw new Error('reviewer')
      }),
    ).rejects.toThrow('reviewer')
    expect(settled).toBe(true)
  })

  it('leaves no failure of the background unhandled while the work runs', async () => {
    const background = Promise.reject(new Error('store'))
    const read = await alongside(background, async () => {
      await new Promise((r) => setTimeout(r, 5))
      return 'read'
    })
    expect(read).toBe('read')
    await expect(background).rejects.toThrow('store')
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

describe('provedOnce', () => {
  const memory = () => {
    const rows = new Map<string, TestProof>()
    const store: ProofStore = {
      load: async (sha) => rows.get(sha),
      save: async (sha, proof) => void rows.set(sha, proof),
    }
    return { rows, store }
  }
  const unproven: TestProof = { outcome: 'unproven', files: ['a.test.ts'] }

  it('runs the step once for a head, whatever the number of reviews', async () => {
    const { rows, store } = memory()
    const known = new Map<string, TestProof>()
    let runs = 0
    const prove = async () => (runs++, unproven)
    const input = { mode: 'auto' as const, sha: 'h1', known, store }
    expect(await provedOnce(input, prove)).toBe(unproven)
    expect(await provedOnce(input, prove)).toBe(unproven)
    expect(runs).toBe(1)
    expect(rows.get('h1')).toBe(unproven)
  })

  it('reads a stored result instead of running again, as a resumed run does', async () => {
    const { rows, store } = memory()
    rows.set('h1', unproven)
    let runs = 0
    const got = await provedOnce(
      { mode: 'trial', sha: 'h1', known: new Map(), store },
      async () => (runs++, unproven),
    )
    expect(got).toEqual(unproven)
    expect(runs).toBe(0)
  })

  it('stores not_run and a new head is a new proof, and adds no finding for not_run', async () => {
    const { rows, store } = memory()
    const notRun: TestProof = { outcome: 'not_run', detail: 'x', files: [] }
    const known = new Map<string, TestProof>()
    await provedOnce({ mode: 'auto', sha: 'h1', known, store }, async () => notRun)
    await provedOnce({ mode: 'auto', sha: 'h2', known, store }, async () => unproven)
    expect(rows.get('h1')).toBe(notRun)
    expect(rows.size).toBe(2)
    expect(addsProofFinding('auto', rows.get('h1'))).toEqual([])
  })

  it('runs nothing and writes no row in off', async () => {
    const { rows, store } = memory()
    let runs = 0
    const got = await provedOnce(
      { mode: 'off', sha: 'h1', known: new Map(), store },
      async () => (runs++, unproven),
    )
    expect(got).toBeUndefined()
    expect(runs).toBe(0)
    expect(rows.size).toBe(0)
  })

  it('keeps an approval from standing while the finding does', () => {
    const found = addsProofFinding('auto', unproven)
    expect(blockedByProof('approve', found)).toBe('changes')
    expect(blockedByProof('approve', [])).toBe('approve')
    expect(blockedByProof('invalid', found)).toBe('invalid')
  })
})

import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

import { TOKEN_LIFE_LEFT_MS } from '../github/app'
import { CREDENTIAL_RENEWAL_MS } from './credential-renewal'
import { JOB_SHUTDOWN_WAIT_MS } from './drain'
import { MAX_RUN_MS } from './run-limit'
import { DEFAULT_TIMEOUTS } from './run'

// A restart must let the run in progress finish (usetheokit/theokit#1292). Four places have to agree on that,
// and each one alone looks right; these tests fail when one of them drifts from the others.
const unit = (name: string) => readFileSync(`ops/systemd/${name}`, 'utf8')
const stopTimeoutMs = (text: string) => {
  const match = /^TimeoutStopSec=(\d+)min$/m.exec(text)
  if (!match) throw new Error('the unit sets no TimeoutStopSec in minutes')
  return Number(match[1]) * 60_000
}
// What loopzero start still takes after the job: closing storage, then up to 25 s to exit.
const AFTER_THE_JOB_MS = 30_000

describe('a restart of a process that runs tasks', () => {
  it('tells loopzero how long to wait, in a key its config schema keeps', async () => {
    // loopzero before 0.79 dropped the key without a word, and the types did not catch it either.
    vi.stubEnv('DATABASE_URL', 'postgres://factory:factory@localhost:1/factory')
    vi.stubEnv('FACTORY_JOBS', '')
    vi.resetModules()
    const { default: loaded } = await import('../../../loopzero.config')
    vi.unstubAllEnvs()

    expect(loaded.jobs?.worker.shutdownTimeoutMs).toBe(JOB_SHUTDOWN_WAIT_MS)
  })

  it('keeps the queue and the cron lock in a server-only process, and takes no job there', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://factory:factory@localhost:1/factory')
    vi.stubEnv('FACTORY_JOBS', '')
    vi.stubEnv('FACTORY_SERVER_ONLY', '1')
    vi.resetModules()
    const { default: loaded } = await import('../../../loopzero.config')
    vi.unstubAllEnvs()

    expect(loaded.jobs?.worker.enabled).toBe(false)
    expect(loaded.jobs?.backend).toBeDefined()
    expect(loaded.cron?.lock).toBeDefined()
  })

  it('lets a run last long enough for a builder, slow checks, a review, a rework and the checks again', () => {
    expect(DEFAULT_TIMEOUTS.sandboxMs).toBe(90 * 60_000)
  })

  it('renews the GitHub token while a run works, so the one it holds has half an hour left at least', () => {
    // A token comes from installationToken with up to an hour left, and is held at most one renewal more.
    const oldestHeld = 60 * 60_000 - TOKEN_LIFE_LEFT_MS + CREDENTIAL_RENEWAL_MS
    expect(60 * 60_000 - oldestHeld).toBeGreaterThanOrEqual(30 * 60_000)
  })

  it('waits for the largest limit an owner may save for a repository', () => {
    expect(JOB_SHUTDOWN_WAIT_MS).toBeGreaterThan(MAX_RUN_MS)
  })

  it('waits for a run longer than a run can last, since its sandbox stops it at the latest', () => {
    expect(JOB_SHUTDOWN_WAIT_MS).toBeGreaterThan(DEFAULT_TIMEOUTS.sandboxMs)
  })

  it('is not cut short by systemd in a worker', () => {
    expect(stopTimeoutMs(unit('aifactory-worker@.service'))).toBeGreaterThanOrEqual(
      JOB_SHUTDOWN_WAIT_MS + AFTER_THE_JOB_MS,
    )
  })

  for (const name of ['aifactory.service', 'aifactory-worker@.service']) {
    it(`signals only the server in ${name}, so the agent's commands keep running while it drains`, () => {
      expect(unit(name)).toMatch(/^KillMode=mixed$/m)
    })
  }

  it('starts the main process as server only, so a restart never waits for a run and stops no cron for it', () => {
    // The main process took run-task jobs too, and a deploy left it draining one for 34 minutes while
    // integrate-after-ci, publish-changesets, coordinate and schedule fired nowhere (2026-11-19).
    expect(unit('aifactory.service')).toMatch(/^Environment=FACTORY_SERVER_ONLY=1$/m)
    expect(unit('aifactory-worker@.service')).not.toMatch(/FACTORY_SERVER_ONLY/)
  })

  it('stops the main process in minutes, since it holds no run', () => {
    expect(stopTimeoutMs(unit('aifactory.service'))).toBeLessThanOrEqual(5 * 60_000)
  })

  it('restarts each worker on its own, never ordered after the main process', () => {
    // A restart of every process stopped the workers first and started them only after the main process
    // drained and came back, so the factory ran no task for as long as the slowest run (2026-11-18, #228).
    expect(unit('aifactory-worker@.service')).not.toMatch(
      /^(After|Requires|BindsTo|PartOf)=.*aifactory\.service/m,
    )
  })

  it('leaves the migrations to the deploy and the main process, so workers starting together do not race on them', () => {
    const script = readFileSync('scripts/run-server.sh', 'utf8')
    expect(script).toMatch(
      /^\[ "\$\{FACTORY_WORKER_ONLY:-\}" = 1 \] \|\| pnpm exec drizzle-kit migrate$/m,
    )
  })

  it('reaches loopzero itself: the script that starts it hands its process over, with no wrapper between', () => {
    const lines = readFileSync('scripts/run-server.sh', 'utf8').trim().split('\n')
    expect(lines.at(-1)).toBe('exec node_modules/.bin/loopzero start')
  })
})

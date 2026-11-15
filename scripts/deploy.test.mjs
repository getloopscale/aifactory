import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const homes = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const readIfThere = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)

const withoutDatabase = ({ DATABASE_URL: _unused, ...env }) => env

/**
 * Runs the real deploy script from a copy of the repository layout, with every outside command replaced by
 * one that writes down how it was called. `busy` is what the database says about working tasks.
 */
function deploy({
  busy = '0',
  enabledWorkers = [],
  checkFails = false,
  migrateFails = false,
  envFile,
  cloudflared = true,
  installedTunnel,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'deploy-test-'))
  homes.push(root)
  mkdirSync(join(root, 'scripts'))
  copyFileSync(new URL('./deploy.sh', import.meta.url), join(root, 'scripts', 'deploy.sh'))
  copyFileSync(
    new URL('./write-units.sh', import.meta.url),
    join(root, 'scripts', 'write-units.sh'),
  )
  chmodSync(join(root, 'scripts', 'write-units.sh'), 0o755)
  mkdirSync(join(root, 'ops', 'systemd'), { recursive: true })
  writeFileSync(join(root, 'ops', 'systemd', 'aifactory.service'), 'ExecStart=@ROOT@/run\n')
  writeFileSync(
    join(root, 'ops', 'systemd', 'aifactory-tunnel.service'),
    'ExecStart=@CLOUDFLARED@ run\n',
  )
  if (envFile !== undefined) writeFileSync(join(root, '.env.local'), envFile)
  const home = join(root, 'home')
  mkdirSync(home)
  const units = join(home, '.config', 'systemd', 'user')
  const tunnel = join(units, 'aifactory-tunnel.service')
  if (installedTunnel !== undefined) {
    mkdirSync(units, { recursive: true })
    writeFileSync(tunnel, installedTunnel)
  }
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const calls = join(root, 'calls.log')
  const fake = (name, body = '') => {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${calls}\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  fake('docker', `echo ${busy}`)
  // `pnpm evals:check` is the agent-configuration gate; the deploy must stop when it fails.
  fake(
    'pnpm',
    `echo "pnpm sees DATABASE_URL=$DATABASE_URL" >> ${calls}\n${checkFails ? 'case "$*" in evals:check*) exit 1 ;; esac' : ''}\n${migrateFails ? 'case "$*" in db:migrate*) exit 1 ;; esac' : ''}`,
  )
  // The fake systemctl keeps state: a unit is enabled when a file of its name is in `enabled`. `list-dependencies`
  // answers with those, `enable` and `disable` add and remove them, and `daemon-reload` and the first `restart`
  // copy the installed unit file as it is at that moment. A unit not seeded there is disabled.
  const state = join(root, 'state')
  mkdirSync(join(state, 'enabled'), { recursive: true })
  for (const unit of ['aifactory.service', ...enabledWorkers]) {
    writeFileSync(join(state, 'enabled', unit), '')
  }
  const installed = join(home, '.config', 'systemd', 'user', 'aifactory.service')
  fake(
    'systemctl',
    `case "$*" in
*list-dependencies*) ls ${state}/enabled ;;
*daemon-reload*) cat ${installed} > ${state}/at-reload 2>/dev/null ;;
*" enable "*) for u in "$@"; do case "$u" in *.service|*.timer) touch ${state}/enabled/$u ;; esac; done ;;
*" disable "*) for u in "$@"; do rm -f ${state}/enabled/$u; done ;;
*" restart "*) [ -e ${state}/at-restart ] || cat ${installed} > ${state}/at-restart 2>/dev/null ;;
esac`,
  )
  fake('curl')
  // cloudflared is on the PATH of the deploy, or on none of the directories of it.
  if (cloudflared) fake('cloudflared')
  const path = process.env.PATH.split(':')
    .filter((dir) => !existsSync(join(dir, 'cloudflared')))
    .join(':')
  fake('journalctl')
  const run = spawnSync('bash', [join(root, 'scripts', 'deploy.sh')], {
    env: { ...withoutDatabase(process.env), HOME: home, PATH: `${bin}:${path}` },
    encoding: 'utf8',
  })
  const code = run.status
  const output = `${run.stdout}${run.stderr}`
  const log = readFileSync(calls, 'utf8').trim().split('\n')
  return {
    code,
    output,
    pnpm: log.filter((l) => l.startsWith('pnpm ') && !l.startsWith('pnpm sees')),
    pnpmEnv: log.filter((l) => l.startsWith('pnpm sees')),
    root,
    bin,
    tunnel: readIfThere(tunnel),
    atReload: readIfThere(join(state, 'at-reload')),
    atRestart: readIfThere(join(state, 'at-restart')),
    enabled: readdirSync(join(state, 'enabled')).sort(),
    systemctl: log.filter((l) => l.startsWith('systemctl ')),
  }
}

describe('the deploy script', () => {
  it('restarts the server, and the feeder only when it is running, after the build', () => {
    const { code, systemctl } = deploy()

    expect(code).toBe(0)
    expect(systemctl).toContain('systemctl --user restart aifactory.service')
    // The feeder opens issues in real repositories, so a deploy never starts it.
    expect(systemctl).toContain('systemctl --user try-restart aifactory-feeder.service')
  })

  it('starts every enabled worker, including one that was stopped', () => {
    const { code, systemctl } = deploy({
      enabledWorkers: ['aifactory-worker@1.service', 'aifactory-worker@2.service'],
    })

    expect(code).toBe(0)
    // try-restart left a stopped worker stopped, and the factory ran fewer tasks at once without saying so.
    expect(systemctl).toContain(
      'systemctl --user restart aifactory-worker@1.service aifactory-worker@2.service',
    )
  })

  it('touches no worker when none is enabled', () => {
    const { code, systemctl } = deploy()

    expect(code).toBe(0)
    expect(systemctl.filter((l) => l.includes('aifactory-worker@'))).toEqual([])
  })

  it('restarts while a task is working, and says the restart waits for it', () => {
    const { code, systemctl, output } = deploy({ busy: '2' })

    expect(code).toBe(0)
    expect(systemctl).toContain('systemctl --user restart aifactory.service')
    expect(output).toMatch(/2 task\(s\) are working; the restart waits for them to finish/)
  })

  it('checks the agent configuration against the baseline before it builds', () => {
    const { code, pnpm } = deploy()

    expect(code).toBe(0)
    expect(pnpm).toEqual(['pnpm db:migrate', 'pnpm evals:check', 'pnpm build'])
  })

  it('builds and restarts nothing when the agents do worse than the baseline', () => {
    const { code, pnpm, systemctl, output } = deploy({ checkFails: true })

    expect(code).not.toBe(0)
    expect(pnpm).toEqual(['pnpm db:migrate', 'pnpm evals:check'])
    expect(systemctl.filter((l) => l.includes('restart'))).toEqual([])
    expect(output).toMatch(/the agents did worse than the baseline/)
  })

  it('gives the check the database the service uses, which .env.local does not name', () => {
    const { code, pnpmEnv } = deploy()

    expect(code).toBe(0)
    const url = 'pnpm sees DATABASE_URL=postgres://factory:factory@localhost:54329/factory'
    expect(pnpmEnv).toEqual([url, url, url])
  })

  it('gives the migration and the check the database .env.local names', () => {
    const { code, pnpmEnv } = deploy({ envFile: 'DATABASE_URL=postgres://other/db\n' })

    expect(code).toBe(0)
    expect(pnpmEnv.slice(0, 2)).toEqual([
      'pnpm sees DATABASE_URL=postgres://other/db',
      'pnpm sees DATABASE_URL=postgres://other/db',
    ])
  })

  it('ends before the build when the migrations fail', () => {
    const { code, pnpm, systemctl, output } = deploy({ migrateFails: true })

    expect(code).not.toBe(0)
    expect(pnpm).toEqual(['pnpm db:migrate'])
    expect(systemctl).toEqual([])
    expect(output).toMatch(/the migrations failed/)
  })

  it('has the release unit files installed when systemd reloads, before the first restart', () => {
    const { code, systemctl, atReload, atRestart, root } = deploy()

    expect(code).toBe(0)
    const rendered = `ExecStart=${join(root, 'run')}\n`
    expect(atReload).toBe(rendered)
    expect(atRestart).toBe(rendered)
    const reload = systemctl.indexOf('systemctl --user daemon-reload')
    const restart = systemctl.findIndex((l) => l.includes(' restart '))
    expect(reload).toBeGreaterThanOrEqual(0)
    expect(reload).toBeLessThan(restart)
    expect(systemctl.filter((l) => /\b(enable|disable)\b/.test(l))).toEqual([])
  })

  it('keeps the installed tunnel unit when cloudflared is not on the PATH of the deploy', () => {
    const installed = 'ExecStart=/opt/bin/cloudflared run\n'
    const { code, tunnel, output, systemctl } = deploy({
      cloudflared: false,
      installedTunnel: installed,
    })

    expect(code).toBe(0)
    expect(tunnel).toBe(installed)
    expect(output).toMatch(
      /cloudflared is not on PATH; aifactory-tunnel.service was left as installed/,
    )
    expect(systemctl).toContain('systemctl --user restart aifactory.service')
  })

  it('stops before the restart when cloudflared is missing and the tunnel unit is not installed', () => {
    const { code, tunnel, output, systemctl } = deploy({ cloudflared: false })

    expect(code).not.toBe(0)
    expect(tunnel).toBeUndefined()
    expect(output).toMatch(/cannot write it/)
    expect(systemctl.filter((l) => l.includes('restart'))).toEqual([])
  })

  it('renders the tunnel unit with the cloudflared of the PATH when there is one', () => {
    const { code, tunnel, bin } = deploy({ installedTunnel: 'old\n' })

    expect(code).toBe(0)
    expect(tunnel).toBe(`ExecStart=${join(bin, 'cloudflared')} run\n`)
  })

  it('leaves a unit that was disabled disabled, and one that was enabled enabled', () => {
    // The tunnel and worker 2 were never enabled; the server and worker 1 were.
    const { code, enabled } = deploy({ enabledWorkers: ['aifactory-worker@1.service'] })

    expect(code).toBe(0)
    expect(enabled).toEqual(['aifactory-worker@1.service', 'aifactory.service'])
  })
})

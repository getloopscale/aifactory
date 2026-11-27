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
  tunnelEnabled = false,
  checkFails = false,
  migrateFails = false,
  envFile,
  cloudflared = true,
  installedCloudflared = false,
  buildFails = false,
  installedTunnel,
  applied = '300',
  copyFails = false,
  slowEval = false,
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
  copyFileSync(new URL('./deploy-db.mjs', import.meta.url), join(root, 'scripts', 'deploy-db.mjs'))
  mkdirSync(join(root, 'drizzle', 'meta'), { recursive: true })
  writeFileSync(
    join(root, 'drizzle', 'meta', '_journal.json'),
    JSON.stringify({
      entries: [
        { tag: '0001_a', when: 100 },
        { tag: '0002_renamed_tables', when: 200 },
        { tag: '0003_c', when: 400 },
      ],
    }),
  )
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
  if (installedCloudflared) {
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'cloudflared'), '#!/bin/sh\n')
    chmodSync(join(elsewhere, 'cloudflared'), 0o755)
    writeFileSync(tunnel, `ExecStart=${join(elsewhere, 'cloudflared')} run\n`)
  }
  const calls = join(root, 'calls.log')
  const fake = (name, body = '') => {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${calls}\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  fake(
    'docker',
    `case "$*" in
*"max(created_at)"*) echo ${applied} ;;
*pg_dump*) ${copyFails ? 'exit 1' : 'echo dump'} ;;
*pg_restore*) cat >/dev/null ;;
*"create database"*|*"drop database"*) ;;
*) echo ${busy} ;;
esac`,
  )
  // `pnpm evals:check` is the agent-configuration gate; the deploy must stop when it fails.
  fake(
    'pnpm',
    `echo "pnpm sees DATABASE_URL=$DATABASE_URL" >> ${calls}\n${slowEval ? `case "$*" in evals:check*) sleep 1; echo "evaluation finished" >> ${calls} ;; esac` : ''}\n${checkFails ? 'case "$*" in evals:check*) exit 1 ;; esac' : ''}\n${buildFails ? 'case "$*" in build*) exit 1 ;; esac' : ''}\n${migrateFails ? 'case "$*$DATABASE_URL" in db:migrate*_eval_*) ;; db:migrate*) exit 1 ;; esac' : ''}`,
  )
  // The fake systemctl keeps state: a unit is enabled when a file of its name is in `enabled`. `list-dependencies`
  // answers with those, `enable` and `disable` add and remove them, and `daemon-reload` and the first `restart`
  // copy the installed unit file as it is at that moment. A unit not seeded there is disabled.
  const state = join(root, 'state')
  mkdirSync(join(state, 'enabled'), { recursive: true })
  for (const unit of [
    'aifactory.service',
    ...enabledWorkers,
    ...(tunnelEnabled ? ['aifactory-tunnel.service'] : []),
  ]) {
    writeFileSync(join(state, 'enabled', unit), '')
  }
  const installed = join(home, '.config', 'systemd', 'user', 'aifactory.service')
  fake(
    'systemctl',
    `case "$*" in
*list-dependencies*) ls ${state}/enabled ;;
*daemon-reload*) cat ${installed} > ${state}/at-reload 2>/dev/null ;;
*is-enabled*) for u in "$@"; do :; done; [ -e ${state}/enabled/$u ] ;;
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
    log,
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
      'systemctl --user restart --no-block aifactory-worker@1.service aifactory-worker@2.service',
    )
  })

  it('touches no worker when none is enabled', () => {
    const { code, systemctl } = deploy()

    expect(code).toBe(0)
    expect(systemctl.filter((l) => l.includes('aifactory-worker@'))).toEqual([])
  })

  it('restarts while a task is working, and says each worker comes back once its run ends', () => {
    const { code, systemctl, output } = deploy({ busy: '2' })

    expect(code).toBe(0)
    expect(systemctl).toContain('systemctl --user restart aifactory.service')
    expect(output).toMatch(
      /2 task\(s\) are working; each worker restarts once its run finishes \(up to four hours\)/,
    )
  })

  it('does not wait for a worker to drain its run, so the next deploy is not held behind it', () => {
    const { systemctl } = deploy({ busy: '1', enabledWorkers: ['aifactory-worker@1.service'] })

    expect(systemctl.filter((l) => l.includes('aifactory-worker@'))).toEqual([
      'systemctl --user restart --no-block aifactory-worker@1.service',
    ])
  })

  it('checks the agent configuration on a migrated copy, builds, then migrates production', () => {
    const { code, pnpm } = deploy()

    expect(code).toBe(0)
    expect(pnpm).toEqual(['pnpm db:migrate', 'pnpm evals:check', 'pnpm build', 'pnpm db:migrate'])
  })

  it('has nothing that waits on an agent between the production migration and the restart', () => {
    const { code, log } = deploy({ slowEval: true })

    expect(code).toBe(0)
    const finished = log.indexOf('evaluation finished')
    const migrations = log.flatMap((l, i) => (l === 'pnpm db:migrate' ? [i] : []))
    const restart = log.findIndex((l) => l.includes(' restart '))
    expect(finished).toBeGreaterThan(-1)
    expect(finished).toBeLessThan(migrations[1])
    expect(log.slice(migrations[1], restart).filter((l) => l.includes('evals:check'))).toEqual([])
    expect(migrations[1]).toBeLessThan(restart)
    expect(log.indexOf('pnpm build')).toBeLessThan(migrations[1])
  })

  it('names the pending migrations before it applies them', () => {
    const { code, output } = deploy({ applied: '200' })

    expect(code).toBe(0)
    expect(output).toMatch(/applying the pending migrations:\n {2}0003_c\n/)
  })

  it('names every migration the journal holds beyond the history, by time and not by number', () => {
    const { output } = deploy({ applied: '100' })

    expect(output).toMatch(/0002_renamed_tables\n {2}0003_c/)
  })

  it('says when no migration is pending', () => {
    const { code, output } = deploy({ applied: '400' })

    expect(code).toBe(0)
    expect(output).toMatch(/no migrations are pending/)
  })

  it('stops before it changes anything when the applied migrations cannot be read', () => {
    const { code, pnpm, systemctl, output } = deploy({ applied: 'x' })

    expect(code).not.toBe(0)
    expect(pnpm).toEqual([])
    expect(systemctl).toEqual([])
    expect(output).toMatch(/could not tell which migrations are pending/)
  })

  it('stops before it changes production when the copy cannot be made', () => {
    const { code, pnpm, systemctl, output, log } = deploy({ copyFails: true })

    expect(code).not.toBe(0)
    expect(pnpm).toEqual([])
    expect(systemctl).toEqual([])
    expect(output).toMatch(/could not copy the database for the evaluation/)
    expect(log.some((l) => l.includes('drop database'))).toBe(true)
  })

  it('removes the evaluation database whether the evaluation passes or fails', () => {
    for (const checkFails of [false, true]) {
      const { log } = deploy({ checkFails })
      const create = log.findIndex((l) => l.includes('create database'))
      const drop = log.findIndex((l) => l.includes('drop database'))
      expect(create).toBeGreaterThan(-1)
      expect(drop).toBeGreaterThan(create)
    }
  })

  it('builds and restarts nothing, and leaves production unmigrated, when the agents do worse than the baseline', () => {
    const { code, pnpm, systemctl, output } = deploy({ checkFails: true })

    expect(code).not.toBe(0)
    expect(pnpm).toEqual(['pnpm db:migrate', 'pnpm evals:check'])
    expect(systemctl.filter((l) => l.includes('restart'))).toEqual([])
    expect(output).toMatch(/the agents did worse than the baseline/)
  })

  it('migrates and restarts nothing when the build fails', () => {
    const { code, pnpm, systemctl } = deploy({ buildFails: true })

    expect(code).not.toBe(0)
    expect(pnpm).toEqual(['pnpm db:migrate', 'pnpm evals:check', 'pnpm build'])
    expect(systemctl).toEqual([])
  })

  it('gives the evaluation a database of its own and production the one the service uses', () => {
    const { code, pnpmEnv } = deploy()

    expect(code).toBe(0)
    const prod = 'pnpm sees DATABASE_URL=postgres://factory:factory@localhost:54329/factory'
    expect(pnpmEnv[0]).toMatch(
      /^pnpm sees DATABASE_URL=postgres:\/\/factory:factory@localhost:54329\/factory_eval_[0-9a-f]{8}$/,
    )
    expect(pnpmEnv[1]).toBe(pnpmEnv[0])
    expect(pnpmEnv[2]).toBe(prod)
    expect(pnpmEnv[3]).toBe(prod)
  })

  it('migrates production in the database .env.local names, after the evaluation', () => {
    const { code, pnpmEnv } = deploy({ envFile: 'DATABASE_URL=postgres://other/db\n' })

    expect(code).toBe(0)
    expect(pnpmEnv[0]).toMatch(/^pnpm sees DATABASE_URL=postgres:\/\/other\/db_eval_/)
    expect(pnpmEnv[3]).toBe('pnpm sees DATABASE_URL=postgres://other/db')
  })

  it('ends before the restart when the production migration fails', () => {
    const { code, pnpm, systemctl, output } = deploy({ migrateFails: true })

    expect(code).not.toBe(0)
    expect(pnpm).toEqual(['pnpm db:migrate', 'pnpm evals:check', 'pnpm build', 'pnpm db:migrate'])
    expect(systemctl.filter((l) => l.includes('restart'))).toEqual([])
    expect(output).toMatch(/the migrations failed/)
  })

  it('has the release unit files installed when systemd reloads, before the first restart', () => {
    const { code, systemctl, atReload, atRestart, root, log } = deploy()

    expect(code).toBe(0)
    const rendered = `ExecStart=${join(root, 'run')}\n`
    expect(atReload).toBe(rendered)
    expect(atRestart).toBe(rendered)
    const order = log.filter((l) => l === 'pnpm build' || l.includes(' restart '))
    expect(order[0]).toBe('pnpm build')
    const reload = systemctl.indexOf('systemctl --user daemon-reload')
    const restart = systemctl.findIndex((l) => l.includes(' restart '))
    expect(reload).toBeGreaterThanOrEqual(0)
    expect(reload).toBeLessThan(restart)
    expect(systemctl.filter((l) => /\b(enable|disable)\b/.test(l))).toEqual([])
  })

  it('renders the tunnel unit with the cloudflared the installed one names when none is on the PATH', () => {
    const { code, tunnel, systemctl } = deploy({
      cloudflared: false,
      installedTunnel: 'old\n',
      installedCloudflared: true,
    })

    expect(code).toBe(0)
    expect(tunnel).toMatch(/^ExecStart=.*\/cloudflared run\n$/)
    expect(systemctl).toContain('systemctl --user restart aifactory.service')
  })

  it('renders the tunnel unit with the installed path even when that path no longer runs', () => {
    const { code, tunnel } = deploy({
      cloudflared: false,
      installedTunnel: 'ExecStart=/gone/cloudflared old\n',
    })

    expect(code).toBe(0)
    expect(tunnel).toBe('ExecStart=/gone/cloudflared run\n')
  })

  it('reads the installed path when the unit writes it in double quotes', () => {
    const { code, tunnel } = deploy({
      cloudflared: false,
      installedTunnel: 'ExecStart="/opt/cloudflared" tunnel run\n',
    })

    expect(code).toBe(0)
    expect(tunnel).toBe('ExecStart=/opt/cloudflared run\n')
  })

  it('renders an enabled tunnel unit with the installed path and does not stop', () => {
    const { code, tunnel } = deploy({
      cloudflared: false,
      tunnelEnabled: true,
      installedTunnel: 'ExecStart=/gone/cloudflared old\n',
    })

    expect(code).toBe(0)
    expect(tunnel).toBe('ExecStart=/gone/cloudflared run\n')
  })

  it('deploys the other units and keeps the installed tunnel unit when no cloudflared runs', () => {
    const installed = 'ExecStart=/usr/bin/other run\n'
    const { code, tunnel, output, systemctl, root, atRestart } = deploy({
      cloudflared: false,
      installedTunnel: installed,
    })

    expect(code).toBe(0)
    expect(tunnel).toBe(installed)
    expect(output).toMatch(/cloudflared is not on PATH.*aifactory-tunnel.service was not written/)
    expect(atRestart).toBe(`ExecStart=${join(root, 'run')}\n`)
    expect(systemctl).toContain('systemctl --user restart aifactory.service')
  })

  it('stops before it writes, builds or restarts when no cloudflared runs and the tunnel is enabled', () => {
    const installed = 'ExecStart=/usr/bin/other run\n'
    const { code, output, tunnel, pnpm, systemctl, atRestart } = deploy({
      cloudflared: false,
      tunnelEnabled: true,
      installedTunnel: installed,
    })

    expect(code).not.toBe(0)
    expect(output).toMatch(/cloudflared/)
    expect(tunnel).toBe(installed)
    expect(pnpm).toEqual([])
    expect(systemctl.filter((l) => /daemon-reload|restart/.test(l))).toEqual([])
    expect(atRestart).toBeUndefined()
  })

  it('deploys without a tunnel unit when none is installed and no cloudflared runs', () => {
    const { code, tunnel, systemctl } = deploy({ cloudflared: false })

    expect(code).toBe(0)
    expect(tunnel).toBeUndefined()
    expect(systemctl).toContain('systemctl --user restart aifactory.service')
  })

  it('leaves the installed units alone when the build fails', () => {
    const installed = 'ExecStart=/old/cloudflared run\n'
    const { code, tunnel, systemctl } = deploy({ buildFails: true, installedTunnel: installed })

    expect(code).not.toBe(0)
    expect(tunnel).toBe(installed)
    expect(systemctl.filter((l) => /daemon-reload|restart/.test(l))).toEqual([])
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

describe('the install script', () => {
  it('keeps its behaviour with no cloudflared: it writes every unit, reloads and enables', () => {
    const root = mkdtempSync(join(tmpdir(), 'install-test-'))
    homes.push(root)
    mkdirSync(join(root, 'scripts'))
    copyFileSync(
      new URL('./install-services.sh', import.meta.url),
      join(root, 'scripts', 'install-services.sh'),
    )
    mkdirSync(join(root, 'ops', 'systemd'), { recursive: true })
    writeFileSync(join(root, 'ops', 'systemd', 'aifactory.service'), 'ExecStart=@ROOT@/run\n')
    writeFileSync(
      join(root, 'ops', 'systemd', 'aifactory-tunnel.service'),
      'ExecStart=@CLOUDFLARED@ run\n',
    )
    const home = join(root, 'home')
    const bin = join(root, 'bin')
    mkdirSync(home)
    mkdirSync(bin)
    const calls = join(root, 'calls.log')
    for (const name of ['systemctl', 'loginctl']) {
      writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${calls}\n`)
      chmodSync(join(bin, name), 0o755)
    }
    const path = process.env.PATH.split(':')
      .filter((dir) => !existsSync(join(dir, 'cloudflared')))
      .join(':')
    const run = spawnSync('bash', [join(root, 'scripts', 'install-services.sh')], {
      env: { ...process.env, HOME: home, USER: 'owner', PATH: `${bin}:${path}` },
      encoding: 'utf8',
    })
    const units = join(home, '.config', 'systemd', 'user')

    expect(run.status).toBe(0)
    expect(readdirSync(units).sort()).toEqual(['aifactory-tunnel.service', 'aifactory.service'])
    const log = readFileSync(calls, 'utf8')
    expect(log).toMatch(/daemon-reload/)
    expect(log).toMatch(/enable aifactory.service aifactory-tunnel.service/)
  })
})

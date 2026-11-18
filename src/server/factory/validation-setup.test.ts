import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const root = new URL('../../../', import.meta.url).pathname
const pnpm = (args: string[], cwd: string) =>
  execFileSync('pnpm', args, {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
  })
let scratch: string | undefined

// The inputs of an install, copied, so the install never touches the checkout.
function installInputs(): string {
  scratch = mkdtempSync(join(tmpdir(), 'frozen-install-'))
  for (const f of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc']) {
    if (existsSync(join(root, f))) copyFileSync(join(root, f), join(scratch, f))
  }
  return scratch
}

/** Everything git sees as changed or untracked, plus the content of the tracked changes. */
const checkoutState = () =>
  execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf8',
  }) + execFileSync('git', ['diff', 'HEAD'], { cwd: root, encoding: 'utf8' })

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = undefined
})

describe('validation setup', () => {
  it('installs frozen, with its build scripts, and the installed tools then work', () => {
    const dir = installInputs()
    const lock = readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')
    pnpm(['install', '--frozen-lockfile'], dir)
    expect(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')).toBe(lock)

    // A dependency-backed test, run by the vitest this install put in place.
    mkdirSync(join(dir, 'probe'))
    writeFileSync(
      join(dir, 'probe', 'zod.test.ts'),
      "import { expect, it } from 'vitest'\nimport { z } from 'zod'\n" +
        "it('uses an installed dependency', () => {\n  expect(z.string().parse('ok')).toBe('ok')\n})\n",
    )
    expect(pnpm(['exec', 'vitest', 'run', '--root', 'probe'], dir)).toMatch(/1 passed/)
    expect(pnpm(['exec', 'prettier', '--check', 'package.json'], dir)).toMatch(
      /Prettier code style/,
    )
  }, 580_000)

  it('refuses a frozen install when package.json drifted from the lockfile', () => {
    const dir = installInputs()
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    pkg.dependencies = { ...pkg.dependencies, 'left-pad-not-in-lockfile': '1.3.0' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg))
    expect(() => pnpm(['install', '--frozen-lockfile'], dir)).toThrow()
  }, 120_000)

  it('runs a dependency-backed test of the checkout and leaves the checkout as it was', () => {
    const before = checkoutState()
    const out = pnpm(
      ['exec', 'vitest', 'run', '--project', 'unit', 'src/server/factory/changed-packages.test.ts'],
      root,
    )
    expect(out).toMatch(/passed/)
    expect(pnpm(['exec', 'prettier', '--check', 'package.json'], root)).toMatch(
      /Prettier code style/,
    )
    expect(checkoutState()).toBe(before)
  }, 120_000)
})

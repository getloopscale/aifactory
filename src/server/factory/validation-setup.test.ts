import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const root = new URL('../../../', import.meta.url).pathname
const FROZEN = ['install', '--frozen-lockfile', '--lockfile-only', '--ignore-scripts']
let scratch: string | undefined

// A copy of the install inputs, so the checkout is never modified by the install.
function installInputs(): string {
  scratch = mkdtempSync(join(tmpdir(), 'frozen-install-'))
  for (const f of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc']) {
    if (existsSync(join(root, f))) copyFileSync(join(root, f), join(scratch, f))
  }
  return scratch
}

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = undefined
})

describe('validation setup', () => {
  it('accepts the committed lockfile in a frozen install and leaves it untouched', () => {
    const dir = installInputs()
    const before = readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')
    execFileSync('pnpm', FROZEN, { cwd: dir, stdio: 'pipe' })
    expect(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')).toBe(before)
  }, 120_000)

  it('refuses a frozen install when package.json drifted from the lockfile', () => {
    const dir = installInputs()
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    pkg.dependencies = { ...pkg.dependencies, 'left-pad-not-in-lockfile': '1.3.0' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg))
    expect(() => execFileSync('pnpm', FROZEN, { cwd: dir, stdio: 'pipe' })).toThrow()
  }, 120_000)

  it('runs the installed prettier through pnpm exec without changing the checkout', () => {
    const before = readFileSync(join(root, 'package.json'), 'utf8')
    // exits non-zero (throws) when prettier is missing or the file is unformatted
    execFileSync('pnpm', ['exec', 'prettier', '--check', 'package.json'], {
      cwd: root,
      stdio: 'pipe',
    })
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(before)
  }, 60_000)
})

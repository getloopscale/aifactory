import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8')

describe('validation setup', () => {
  it('runs the formatter through pnpm exec', () => {
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>
    expect(scripts.format).toBe('pnpm exec prettier --write .')
    expect(scripts['format:check']).toBe('pnpm exec prettier --check .')
  })

  it('documents the frozen install before validation', () => {
    const readme = read('README.md')
    expect(readme).toContain('corepack enable && pnpm install --frozen-lockfile')
    expect(readme).toContain('pnpm exec prettier --check')
  })

  it('uses the frozen install in the local setup too', () => {
    expect(read('README.md')).not.toMatch(/^pnpm install\s*$/m)
  })

  it('can be installed frozen: corepack pins pnpm and a lockfile exists', () => {
    const pkg = JSON.parse(read('package.json')) as { packageManager?: string }
    expect(pkg.packageManager).toMatch(/^pnpm@\d/)
    expect(existsSync(new URL('../../../pnpm-lock.yaml', import.meta.url))).toBe(true)
  })
})

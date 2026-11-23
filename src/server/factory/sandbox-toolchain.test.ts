import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { SANDBOX_TOOLCHAIN } from './sandbox-toolchain'

const dockerfile = readFileSync(new URL('../../../ops/sandbox/Dockerfile', import.meta.url), 'utf8')

describe('the sandbox toolchain', () => {
  // The E2B template is built from the same Dockerfile (scripts/build-e2b-template.mts), so both carry this.
  it('is the one the Dockerfile installs', () => {
    expect(dockerfile).toContain(`FROM node:${SANDBOX_TOOLCHAIN.node}-`)
    expect(dockerfile).toContain(`corepack prepare pnpm@${SANDBOX_TOOLCHAIN.pnpm} `)
    expect(dockerfile).toContain(`nodedir=${SANDBOX_TOOLCHAIN.nodeHeadersDir}`)
    expect(SANDBOX_TOOLCHAIN.nodeHeaders).toBe(SANDBOX_TOOLCHAIN.node)
  })

  it('names the pnpm the factory itself declares', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'))
    expect(pkg.packageManager).toBe(`pnpm@${SANDBOX_TOOLCHAIN.pnpm}`)
  })
})

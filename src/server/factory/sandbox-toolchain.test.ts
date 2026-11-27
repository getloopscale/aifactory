import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  CHECKER_DICTIONARY_PATHS,
  SANDBOX_DICTIONARY_PACKAGES,
  SANDBOX_DICTIONARY_PRESENT,
  SANDBOX_TOOLCHAIN,
} from './sandbox-toolchain'

const dockerfile = readFileSync(new URL('../../../ops/sandbox/Dockerfile', import.meta.url), 'utf8')

describe('the sandbox toolchain', () => {
  // The E2B template is built from the same Dockerfile (scripts/build-e2b-template.mts), so both carry this.
  it('is the one the Dockerfile installs', () => {
    expect(dockerfile).toContain(`FROM node:${SANDBOX_TOOLCHAIN.node}-`)
    expect(dockerfile).toContain(`corepack prepare pnpm@${SANDBOX_TOOLCHAIN.pnpm} `)
    expect(dockerfile).toContain(`nodedir=${SANDBOX_TOOLCHAIN.nodeHeadersDir}`)
    expect(SANDBOX_TOOLCHAIN.nodeHeaders).toBe(SANDBOX_TOOLCHAIN.node)
  })

  // A repository check that reads /usr/share/dict (loopzero's LoopCode english-only lint) fails closed without them,
  // and reads a different lexicon when the image adds a list: the packages are exactly the CI runner's pair.
  it('installs only the word-list packages named in SANDBOX_DICTIONARY_PACKAGES', () => {
    const installed = /apt-get install -y --no-install-recommends ([^\\\n]+)/
      .exec(dockerfile)?.[1]
      .split(' ')
    const dictionaries = (installed ?? []).filter((p) =>
      /^(w[a-z]+|hunspell.*|dict.*|myspell.*)$/.test(p),
    )
    expect(dictionaries.filter((p) => p !== 'wget').sort()).toEqual(
      [...SANDBOX_DICTIONARY_PACKAGES].sort(),
    )
  })

  it('has no Dockerfile step, outside comments, that adds or links a word list of its own', () => {
    expect(dockerfile.replace(/^#.*$/gm, '')).not.toMatch(
      /hunspell|\/usr\/share\/dict|\/etc\/dictionaries-common/,
    )
  })

  it('expects present, of the six paths the checker reads, exactly the ones its packages provide', () => {
    expect(CHECKER_DICTIONARY_PATHS).toHaveLength(6)
    expect(SANDBOX_DICTIONARY_PRESENT).toEqual([
      '/usr/share/dict/american-english',
      '/usr/share/dict/words',
      '/usr/share/dict/brazilian',
    ])
  })

  it('names the pnpm the factory itself declares', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'))
    expect(pkg.packageManager).toBe(`pnpm@${SANDBOX_TOOLCHAIN.pnpm}`)
  })
})

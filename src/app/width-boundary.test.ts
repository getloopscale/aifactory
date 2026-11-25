import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  )
}

describe('the width of the window', () => {
  it('is read only by useWidthClass', () => {
    const offenders = files(__dirname)
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.endsWith('lib/media.ts'))
      .filter((f) => /matchMedia|innerWidth/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, it } from 'vitest'

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)],
  )

it('no file under factory/ imports trace/export: the run never waits for the export', () => {
  const offenders = filesUnder(join(__dirname, '..', 'factory'))
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.test.ts'))
    .filter((f) => /from\s+['"][^'"]*trace\/export['"]/.test(readFileSync(f, 'utf8')))
  expect(offenders).toEqual([])
})

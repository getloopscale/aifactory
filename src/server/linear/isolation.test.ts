import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { assertIsolated, IsolationRefused } from '../factory/sandbox'

const SERVER = join(__dirname, '..')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [path] : []
  })
}
const files = sources(SERVER).map((path) => ({ path, text: readFileSync(path, 'utf8') }))
const mentioning = (needle: RegExp) =>
  files.filter((f) => needle.test(f.text)).map((f) => f.path.slice(SERVER.length + 1))

describe('the Linear credential stays on the host', () => {
  it('is read from the environment in one place only', () => {
    expect(mentioning(/LINEAR_API_KEY/)).toEqual(['work-source/tracker.ts'])
  })

  it('never reaches a file that builds a sandbox, its environment or its egress', () => {
    const sandboxFiles = files.filter((f) =>
      /\/factory\/(sandbox|docker-sandbox|e2b-sandbox|vercel-sandbox|fake-sandbox|egress)[^/]*\.ts$/.test(
        f.path,
      ),
    )
    expect(sandboxFiles.length).toBeGreaterThan(3)
    for (const f of sandboxFiles) {
      expect(f.text, f.path).not.toMatch(/linear/i)
    }
  })

  it('is used by no module that starts a sandbox or an agent', () => {
    // Only the host-side tracker and ingestion import the Linear client or the key.
    const importers = mentioning(
      /from '(\.\.\/)+linear\/|from '\.\/linear-record'|work-source\/tracker'/,
    )
    for (const path of importers) {
      expect(path).not.toMatch(/^(factory\/(run|plan|prove-checks|sandbox)|evals\/run-case)\.ts$/)
    }
  })

  it('a sandbox cannot be given a path to Linear: its egress is an explicit list of domains', () => {
    const spec = (domain: string) => ({
      egress: [{ domain }],
      timeoutMs: 1000,
    })
    expect(() => assertIsolated(spec('*') as never)).toThrow(IsolationRefused)
    expect(() => assertIsolated(spec('api.github.com') as never)).not.toThrow()
  })
})

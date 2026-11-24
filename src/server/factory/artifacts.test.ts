import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SandboxBackend } from '@theokit/agents/sandbox'
import { describe, expect, it } from 'vitest'

import {
  artifactContentType,
  artifactHeaders,
  collectArtifacts,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_FILES,
  ofLatestVerification,
  safeArtifactPath,
} from './artifacts'

/** A backend that runs the command on this machine, which is all the collection needs. */
const local: SandboxBackend = {
  async execute(command: string) {
    try {
      const stdout = execFileSync('bash', ['-c', command], { maxBuffer: 1 << 28 }).toString()
      return { stdout, stderr: '', exitCode: 0 }
    } catch (error) {
      const e = error as { status?: number; stdout?: Buffer }
      return { stdout: e.stdout?.toString() ?? '', stderr: '', exitCode: e.status ?? 1 }
    }
  },
} as unknown as SandboxBackend

const repo = () => realpathOf(mkdtempSync(join(tmpdir(), 'artifacts-')))
const realpathOf = (p: string) => execFileSync('realpath', [p]).toString().trim()

describe('safeArtifactPath', () => {
  it('takes a relative path and refuses an absolute one, a traversal and a flag', () => {
    expect(safeArtifactPath('screenshots/')).toBe(true)
    expect(safeArtifactPath('/etc/passwd')).toBe(false)
    expect(safeArtifactPath('../x')).toBe(false)
    expect(safeArtifactPath('a/../../x')).toBe(false)
    expect(safeArtifactPath('-rf')).toBe(false)
    expect(safeArtifactPath('a\nb')).toBe(false)
  })
})

describe('collectArtifacts', () => {
  it('copies the files under a declared directory', async () => {
    const dir = repo()
    mkdirSync(join(dir, 'screenshots'))
    writeFileSync(join(dir, 'screenshots/home.png'), 'png-bytes')
    const got = await collectArtifacts(local, dir, ['screenshots/'])
    expect(got.omitted).toEqual([])
    expect(got.artifacts.map((a) => [a.path, a.contentType, a.content.toString()])).toEqual([
      ['screenshots/home.png', 'image/png', 'png-bytes'],
    ])
  })

  it('stores what fits under the count limit and says what was left out', async () => {
    const dir = repo()
    mkdirSync(join(dir, 'out'))
    for (let i = 0; i < MAX_ARTIFACT_FILES + 2; i++) {
      writeFileSync(join(dir, `out/f${String(i).padStart(2, '0')}.txt`), 'x')
    }
    const got = await collectArtifacts(local, dir, ['out'])
    expect(got.artifacts).toHaveLength(MAX_ARTIFACT_FILES)
    expect(got.omitted).toHaveLength(2)
    expect(got.omitted[0]).toContain('over the limit')
  })

  it('leaves out a file that does not fit the size limit', async () => {
    const dir = repo()
    mkdirSync(join(dir, 'out'))
    writeFileSync(join(dir, 'out/small.txt'), 'x')
    execFileSync('truncate', ['-s', String(MAX_ARTIFACT_BYTES + 1), join(dir, 'out/big.bin')])
    const got = await collectArtifacts(local, dir, ['out'])
    expect(got.artifacts.map((a) => a.path)).toEqual(['out/small.txt'])
    expect(got.omitted.join()).toContain('out/big.bin')
  })

  it('does not follow a link that leads out of the checkout', async () => {
    const dir = repo()
    const outside = repo()
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    mkdirSync(join(dir, 'out'))
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'out/link.txt'))
    symlinkSync(outside, join(dir, 'out/dir'))
    const got = await collectArtifacts(local, dir, ['out'])
    expect(got.artifacts).toEqual([])
  })

  it('omits an unsafe declaration instead of failing', async () => {
    const got = await collectArtifacts(local, repo(), ['../x'])
    expect(got.artifacts).toEqual([])
    expect(got.omitted).toEqual(['../x: not a path inside the repository'])
  })
})

describe('artifactHeaders', () => {
  it('offers an html file as a download that nothing renders', () => {
    const type = artifactContentType('page.html')
    expect(type).toBe('application/octet-stream')
    const headers = artifactHeaders('reports/page.html', type)
    expect(headers['content-disposition']).toBe('attachment; filename="page.html"')
    expect(headers['content-type']).toBe('application/octet-stream')
    expect(headers['x-content-type-options']).toBe('nosniff')
  })

  it('shows an image in the page', () => {
    const headers = artifactHeaders('home.png', 'image/png')
    expect(headers['content-type']).toBe('image/png')
    expect(headers['content-disposition']).toMatch(/^inline/)
  })

  it('never lets the type of a stored file be html or svg', () => {
    expect(artifactHeaders('x.svg', 'image/svg+xml')['content-type']).toBe(
      'application/octet-stream',
    )
    expect(artifactHeaders('x.html', 'text/html')['content-disposition']).toMatch(/^attachment/)
  })
})

describe('ofLatestVerification', () => {
  it('keeps only the files of the checks run on the newest commit', () => {
    const checks = [
      { id: 1, sha: 'old' },
      { id: 2, sha: 'new' },
      { id: 3, sha: 'new' },
    ]
    const files = [
      { id: 10, evidenceId: 1 },
      { id: 11, evidenceId: 2 },
      { id: 12, evidenceId: 3 },
    ]
    expect(ofLatestVerification(checks, files).map((f) => f.id)).toEqual([11, 12])
    expect(ofLatestVerification([], files)).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'

import type { GithubApi } from '../github/pulls'

import { manifestRefusal, manifestsOutOfStep } from './tag-manifest'

function api(files: Record<string, string>): GithubApi {
  return {
    filePaths: async () => Object.keys(files),
    readFile: async (_r: string, _t: string, path: string) => files[path],
  } as unknown as GithubApi
}
const run = (files: Record<string, string>) =>
  manifestsOutOfStep(api(files), { repo: 'o/r', token: 't', ref: 'abcdef123', tag: 'v0.80.1' })

describe('manifestsOutOfStep', () => {
  it('accepts a manifest that carries the version', async () => {
    expect(await run({ 'package.json': '{"name":"a","version":"0.80.1"}' })).toEqual([])
  })
  it('names a nested manifest that does not', async () => {
    const found = await run({
      'package.json': '{"name":"root","private":true,"version":"0.0.0"}',
      'packages/tui/package.json': '{"name":"@x/tui","version":"0.80.0"}',
      'node_modules/a/package.json': '{"name":"a","version":"9.9.9"}',
    })
    expect(found).toEqual([{ path: 'packages/tui/package.json', version: '0.80.0' }])
    expect(manifestRefusal('v0.80.1', 'abcdef123', found)).toContain('packages/tui/package.json')
  })
  it('ignores manifests with no name or version, and repositories with none', async () => {
    expect(
      await run({ 'a/package.json': '{"name":"a"}', 'b/package.json': '{"version":"1"}' }),
    ).toEqual([])
    expect(await run({ 'README.md': 'x' })).toEqual([])
  })
  it('throws for a manifest that cannot be read', async () => {
    await expect(run({ 'package.json': '{' })).rejects.toThrow('not valid JSON')
    const gone = { filePaths: async () => ['package.json'], readFile: async () => undefined }
    await expect(
      manifestsOutOfStep(gone as unknown as GithubApi, {
        repo: 'o/r',
        token: 't',
        ref: 'r',
        tag: 'v1.0.0',
      }),
    ).rejects.toThrow('is not on')
  })
})

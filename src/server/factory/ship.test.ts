import { describe, expect, it } from 'vitest'

import type { GithubApi } from '../github/pulls'

import { issueComment, type Shipment } from './ship'

const shipment: Shipment = {
  repository: 'o/r',
  token: 't',
  promotedSha: 'abcdef1234',
  releaseBranch: 'main',
  askedTaskId: 1,
  actor: 'human',
  tags: [
    { tag: '@s/a@1.0.0', url: 'https://x/a' },
    { tag: '@s/b@2.0.0', url: 'https://x/b' },
  ],
}

const MANIFESTS: Record<string, string> = {
  'packages/a/package.json': JSON.stringify({ name: '@s/a', version: '1.0.0' }),
  'packages/b/package.json': JSON.stringify({ name: '@s/b', version: '2.0.0' }),
  'packages/c/package.json': JSON.stringify({ name: '@s/c', version: '0.0.0', private: true }),
  '.changeset/config.json': JSON.stringify({ ignore: ['@s/c'] }),
}

const api = (changed: string[], fails = false) =>
  ({
    changedFiles: async () => {
      if (fails) throw new Error('comparison too large')
      return changed.map((path) => ({ path, status: 'modified' }))
    },
    filePaths: async () => Object.keys(MANIFESTS),
    readFile: async (_r: string, _t: string, path: string) => MANIFESTS[path],
  }) as unknown as GithubApi

describe('issueComment', () => {
  it('names no version of a package the task did not change, when it changed only an ignored one', async () => {
    const body = await issueComment(api(['packages/c/src/x.ts']), shipment, 'm1')
    expect(body).not.toContain('@s/a@1.0.0')
    expect(body).not.toContain('@s/b@2.0.0')
    expect(body).toContain('Released to `main` in abcdef1')
    expect(body).toContain('not published to npm')
  })

  it('names the version of the package the task changed and not the others', async () => {
    const body = await issueComment(api(['packages/a/src/x.ts']), shipment, 'm1')
    expect(body).toContain('Available in `@s/a@1.0.0`')
    expect(body).not.toContain('@s/b@2.0.0')
  })

  it('does not claim a version when the change cannot be read', async () => {
    const body = await issueComment(api([], true), shipment, 'm1')
    expect(body).not.toContain('@s/')
    expect(body).toContain('could not be determined')
  })

  it('names every tag of a release that is not a changesets one', async () => {
    const plain = { ...shipment, tags: [{ tag: 'v1.0.0', url: 'https://x/v' }] }
    expect(await issueComment(api([]), plain, 'm1')).toContain('Available in `v1.0.0`')
  })
})

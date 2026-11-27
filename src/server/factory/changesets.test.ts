import { describe, expect, it } from 'vitest'

import {
  CHANGESET_CHECK,
  CHANGESET_CHECK_PATH,
  addedChangesets,
  changesetIgnore,
  changesetPackages,
  enclosingPackages,
  isIgnored,
  packageDirs,
  parseManifest,
  publishedTouched,
  isPackageTag,
  touchedPaths,
  usesChangesets,
  pickBackMerge,
  pickVersionSuccessor,
  noReleasesRead,
  RELEASE_RUN_GRACE_MS,
  releasesRead,
  VERSION_RELEASES_WAIT_MS,
  versionedTag,
  releaseRunGraceOver,
  releaseRunOf,
  versionBranchFor,
  versionBranchWaits,
  versionPullRequestFrom,
  withChangesetCheck,
} from './changesets'

describe('usesChangesets', () => {
  it('is false for a repository without a .changeset directory or without its config', () => {
    expect(usesChangesets(undefined)).toBe(false)
    expect(usesChangesets(['README.md', 'brave-fox.md'])).toBe(false)
  })

  it('is true when .changeset holds its config, with or without changesets', () => {
    expect(usesChangesets(['config.json', 'README.md'])).toBe(true)
  })
})

describe('addedChangesets', () => {
  const file = (path: string, status = 'added') => ({ path, status })

  it('is the markdown files a comparison adds under .changeset, the README left out', () => {
    expect(
      addedChangesets([
        file('.changeset/brave-fox.md'),
        file('.changeset/README.md'),
        file('.changeset/config.json'),
        file('.changeset/pre.json'),
        file('docs/notes.md'),
        file('.changeset/nested/deep.md'),
        file('docs/.changeset/elsewhere.md'),
        file('.changeset/draft.md.bak'),
      ]),
    ).toEqual(['.changeset/brave-fox.md'])
  })

  it('is nothing for changesets the base already had: a release branch that consumed them does not make them pending', () => {
    expect(
      addedChangesets([
        file('.changeset/wake-word-detector.md', 'modified'),
        file('.changeset/old-one.md', 'removed'),
        file('.changeset/moved.md', 'renamed'),
        file('CHANGELOG.md'),
      ]),
    ).toEqual([])
  })
})

describe('touchedPaths', () => {
  it('names every file a comparison lists, a rename by both names', () => {
    expect(
      touchedPaths([
        { path: 'a.ts', status: 'modified' },
        { path: 'b.md', status: 'renamed', previousPath: 'old/b.md' },
      ]),
    ).toEqual(['a.ts', 'b.md', 'old/b.md'])
  })
})

describe('releaseRunGraceOver', () => {
  const started = new Date('2026-11-12T13:28:51Z')
  const after = (ms: number) => new Date(started.getTime() + ms)

  it('is over once the grace window after the promotion has passed, and not a moment before', () => {
    expect(RELEASE_RUN_GRACE_MS).toBe(10 * 60_000)
    expect(releaseRunGraceOver(started, after(RELEASE_RUN_GRACE_MS - 1))).toBe(false)
    expect(releaseRunGraceOver(started, after(RELEASE_RUN_GRACE_MS))).toBe(true)
  })
})

describe('versionedTag', () => {
  const path = 'packages/gateway/package.json'

  it('is the release changesets makes for a published package whose version the merge moved', () => {
    expect(
      versionedTag(
        '{"name":"@getloopscale/loopzero-gateway","version":"0.16.0"}',
        '{"name":"@getloopscale/loopzero-gateway","version":"0.16.1"}',
        path,
      ),
    ).toBe('@getloopscale/loopzero-gateway@0.16.1')
  })

  it('is the first release of a package the merge added', () => {
    expect(
      versionedTag(undefined, '{"name":"@getloopscale/loopzero-new","version":"0.1.0"}', path),
    ).toBe('@getloopscale/loopzero-new@0.1.0')
  })

  it('is nothing when the merge changed the manifest but kept its version', () => {
    expect(
      versionedTag(
        '{"name":"@getloopscale/loopzero-gateway","version":"0.16.1","dependencies":{"a":"1"}}',
        '{"name":"@getloopscale/loopzero-gateway","version":"0.16.1","dependencies":{"a":"2"}}',
        path,
      ),
    ).toBeUndefined()
  })

  it('is nothing for a private package, which changesets versions but never publishes', () => {
    expect(
      versionedTag(
        '{"name":"example","version":"0.1.0","private":true}',
        '{"name":"example","version":"0.1.1","private":true}',
        path,
      ),
    ).toBeUndefined()
  })

  it('is nothing for a manifest without a name or a version', () => {
    expect(versionedTag(undefined, '{"version":"1.0.0"}', path)).toBeUndefined()
    expect(
      versionedTag(
        '{"name":"@getloopscale/loopzero-gateway","version":"0.16.0"}',
        '{"name":"@getloopscale/loopzero-gateway"}',
        path,
      ),
    ).toBeUndefined()
  })

  it('names the manifest that is not valid JSON', () => {
    expect(() => versionedTag(undefined, '{', path)).toThrow(/packages\/gateway\/package.json/)
    expect(() => versionedTag('{', '{"name":"a","version":"1.0.0"}', path)).toThrow(
      /packages\/gateway\/package.json/,
    )
  })
})

describe('releasesRead', () => {
  const merged = new Date('2026-11-12T13:00:00Z')
  const after = (ms: number) => new Date(merged.getTime() + ms)
  const expected = [
    '@getloopscale/loopzero-gateway-yuanbao@0.1.1',
    '@getloopscale/loopzero-gateway-slack@0.5.1',
    '@getloopscale/loopzero-gateway@0.16.1',
  ]

  it('is complete, with nothing to add, once every versioned package has its release', () => {
    expect(releasesRead(expected, [...expected, 'other@1.0.0'], merged, after(0))).toEqual({
      complete: '',
    })
  })

  it('is complete when the merge versioned no package it can name', () => {
    expect(releasesRead([], ['@getloopscale/loopzero-ui@1.13.0'], merged, after(0))).toEqual({
      complete: '',
    })
  })

  it('waits, naming the package, while one release is missing and the bounded wait lasts', () => {
    expect(VERSION_RELEASES_WAIT_MS).toBe(30 * 60_000)
    expect(
      releasesRead(expected, expected.slice(0, 2), merged, after(VERSION_RELEASES_WAIT_MS - 1)),
    ).toEqual({
      wait: 'waiting for the release workflow to publish @getloopscale/loopzero-gateway@0.16.1',
    })
  })

  it('names every missing release', () => {
    expect(releasesRead(expected, expected.slice(0, 1), merged, after(0))).toEqual({
      wait: 'waiting for the release workflow to publish @getloopscale/loopzero-gateway-slack@0.5.1, @getloopscale/loopzero-gateway@0.16.1',
    })
  })

  it('stops waiting once the bounded wait is over, and says which release is missing', () => {
    expect(
      releasesRead(expected, expected.slice(0, 2), merged, after(VERSION_RELEASES_WAIT_MS)),
    ).toEqual({
      complete:
        '; no release for @getloopscale/loopzero-gateway@0.16.1 30 minutes after the Version Packages merge',
    })
  })
})

describe('releaseRunOf', () => {
  const sha = 'c06b47361e6316a06e0e7630535814b087cbf52e'

  it('is finished when every check on the promoted commit completed and none failed', () => {
    expect(releaseRunOf({ state: 'green', failing: [] }, sha)).toEqual({ finished: true })
  })

  it('failed, naming the checks, when one failed', () => {
    expect(releaseRunOf({ state: 'red', failing: ['Release via Changesets', 'CI'] }, sha)).toEqual({
      failed: 'Release via Changesets, CI failed on c06b473',
    })
  })

  it('waits while a check still runs, and while none has reported', () => {
    expect(releaseRunOf({ state: 'pending', failing: [] }, sha)).toEqual({
      wait: expect.stringMatching(/the checks on c06b473 still run$/),
    })
    expect(releaseRunOf({ state: 'none', failing: [] }, sha)).toEqual({
      wait: expect.stringMatching(/no check has reported on c06b473$/),
    })
  })
})

describe('versionBranchFor', () => {
  it('is the branch changesets/action opens its Version Packages pull request from', () => {
    expect(versionBranchFor('main')).toBe('changeset-release/main')
  })
})

describe('versionBranchWaits', () => {
  const branch = (aheadBy: number, committedAt: string) => ({
    sha: 'v1',
    aheadBy,
    committedAt: new Date(committedAt),
  })

  it('is true for a branch ahead of the release branch that holds the promoted commit', () => {
    expect(versionBranchWaits(branch(1, '2026-11-12T10:04:00Z'), true)).toBe(true)
  })

  it('is true whatever the commit time: a late record of the publication does not matter', () => {
    expect(versionBranchWaits(branch(1, '2026-11-12T09:59:59Z'), true)).toBe(true)
  })

  it('is false when there is no such branch', () => {
    expect(versionBranchWaits(undefined, true)).toBe(false)
  })

  it('is false for a branch the release branch already holds', () => {
    expect(versionBranchWaits(branch(0, '2026-11-12T10:04:00Z'), true)).toBe(false)
  })

  it('is false for a branch that does not hold the promoted commit, however recent', () => {
    expect(versionBranchWaits(branch(1, '2026-11-12T10:04:00Z'), false)).toBe(false)
    expect(versionBranchWaits(branch(1, '2026-11-12T09:59:59Z'), false)).toBe(false)
  })
})

describe('versionPullRequestFrom', () => {
  it('opens Version Packages from the version branch into the release branch, naming the promoted commit', () => {
    const pull = versionPullRequestFrom('main', 'c06b4731234567')

    expect(pull).toMatchObject({
      head: 'changeset-release/main',
      base: 'main',
      title: 'Version Packages',
    })
    expect(pull.body).toContain('c06b4731234567')
    expect(pull.body).toContain('changeset-release/main')
  })
})

describe('isPackageTag', () => {
  it('recognises the tags changesets publishes, scoped or not', () => {
    expect(isPackageTag('@getloopscale/loopzero-ui@1.13.0')).toBe(true)
    expect(isPackageTag('theokit@3.0.19')).toBe(true)
    expect(isPackageTag('@getloopscale/loopzero-sdk@5.14.0-next.1')).toBe(true)
  })

  it('leaves out a version tag of its own and the factory pre-releases', () => {
    expect(isPackageTag('v1.3.0')).toBe(false)
    expect(isPackageTag('pre/172-9095546')).toBe(false)
  })

  it('takes only a whole tag of that shape, with versions of more than one digit', () => {
    expect(isPackageTag('@getloopscale/loopzero-gateway-slack@10.2.3')).toBe(true)
    expect(isPackageTag('release notes for @getloopscale/loopzero-ui@1.13.0')).toBe(false)
    expect(isPackageTag('@getloopscale/loopzero-ui@1.13.0 (draft)')).toBe(false)
  })
})

describe('changesetPackages', () => {
  it('is the packages the front matter names, quoted either way or bare', () => {
    const text =
      '---\n"@getloopscale/loopzero-ui": minor\n\'loopzero\': patch\n  create-app : major\n---\n\nSays why.\n'

    expect(changesetPackages(text)).toEqual(['@getloopscale/loopzero-ui', 'loopzero', 'create-app'])
  })

  it('is nothing for an empty changeset, the one `changeset add --empty` writes', () => {
    expect(changesetPackages('---\n---\n')).toEqual([])
    expect(changesetPackages('---\n\n---\n\nA private app changed.\n')).toEqual([])
  })

  it('reads only the front matter: a line of the summary names nothing', () => {
    expect(
      changesetPackages('---\n---\n\nfix: the parser\n"@getloopscale/loopzero-ui": minor\n'),
    ).toEqual([])
    expect(changesetPackages('"@getloopscale/loopzero-ui": minor\n')).toEqual([])
    expect(changesetPackages('---\n"@getloopscale/loopzero-ui": minor\n')).toEqual([])
  })

  it('takes a line only when it has a name and a bump', () => {
    expect(
      changesetPackages(
        '---\n"@getloopscale/loopzero-ui":\n: patch\n"": patch\nno bump here\n---\n',
      ),
    ).toEqual([])
  })

  it('takes the fences with spaces around them, and no bump made only of spaces', () => {
    expect(changesetPackages('---  \n"@getloopscale/loopzero-ui": minor\n ---  \n')).toEqual([
      '@getloopscale/loopzero-ui',
    ])
    expect(changesetPackages('---\n"@getloopscale/loopzero-ui":   \n---\n')).toEqual([])
  })

  it('names nothing when the file does not open with a fence, though one closes later', () => {
    expect(changesetPackages('Notes\n"@getloopscale/loopzero-ui": minor\n---\n')).toEqual([])
  })

  it('strips only the quotes around a name', () => {
    expect(changesetPackages('---\n"o\'neil": patch\n---\n')).toEqual(["o'neil"])
    expect(changesetPackages("---\n'say\"cheese': patch\n---\n")).toEqual(['say"cheese'])
  })

  it('reads a file with Windows line ends, or with blank lines before the front matter', () => {
    expect(changesetPackages('\n\n---\r\n"@getloopscale/loopzero-ui": minor\r\n---\r\n')).toEqual([
      '@getloopscale/loopzero-ui',
    ])
  })
})

describe('withChangesetCheck', () => {
  const checks = [{ name: 'install', command: 'pnpm install --frozen-lockfile' }]

  it('adds the changeset check, against the integration branch, when the repository uses changesets', () => {
    expect(withChangesetCheck(checks, true, 'workspace')).toEqual([
      ...checks,
      { name: CHANGESET_CHECK, command: `node ${CHANGESET_CHECK_PATH} origin/workspace` },
    ])
    expect(CHANGESET_CHECK_PATH).toBe('/tmp/factory-changeset-check.mjs')
  })

  it('leaves the checks alone when the repository does not use changesets', () => {
    expect(withChangesetCheck(checks, false, 'workspace')).toBe(checks)
  })

  it('does not add it twice when the owner already lists a check of that name', () => {
    const own = [...checks, { name: CHANGESET_CHECK, command: 'pnpm changeset status' }]
    expect(withChangesetCheck(own, true, 'workspace')).toBe(own)
  })
})

describe('pickBackMerge', () => {
  const branches = { repo: 'usetheokit/theokit', release: 'main', integration: 'workspace' }
  const backMerge = {
    number: 1738,
    url: 'https://github.com/usetheokit/theokit/pull/1738',
    headSha: 'main-head',
    headRef: 'main',
    headRepo: 'usetheokit/theokit',
    baseRef: 'workspace',
    draft: false,
  }

  it('takes the pull request from the release branch into the integration branch of the same repository', () => {
    expect(pickBackMerge([backMerge], branches)).toBe(backMerge)
  })

  it('finds it among other open pull requests', () => {
    const other = { ...backMerge, number: 1, headRef: 'factory/7' }
    expect(pickBackMerge([other, backMerge], branches)).toBe(backMerge)
  })

  it('never takes a pull request from another head into the integration branch', () => {
    expect(pickBackMerge([{ ...backMerge, headRef: 'factory/7' }], branches)).toBeUndefined()
    expect(pickBackMerge([{ ...backMerge, headRef: 'develop' }], branches)).toBeUndefined()
  })

  it('never takes the release branch into another base', () => {
    expect(pickBackMerge([{ ...backMerge, baseRef: 'develop' }], branches)).toBeUndefined()
  })

  it('never takes a release branch of the same name pushed to a fork', () => {
    expect(
      pickBackMerge([{ ...backMerge, headRepo: 'someone/loopzero' }], branches),
    ).toBeUndefined()
  })

  it('is nothing when no pull request is open', () => {
    expect(pickBackMerge([], branches)).toBeUndefined()
  })
})

describe('packageDirs', () => {
  it('names the directory of every package.json, the root as the empty one', () => {
    expect(
      packageDirs([
        'package.json',
        'README.md',
        'packages/ui/package.json',
        'packages/ui/src/index.ts',
        'apps/loopbot/package.json',
      ]),
    ).toEqual(['', 'packages/ui', 'apps/loopbot'])
  })

  it('leaves out a vendored node_modules and a file merely ending in package.json', () => {
    expect(packageDirs(['vendor/node_modules/x/package.json', 'docs/not-a-package.json'])).toEqual(
      [],
    )
  })
})

describe('enclosingPackages', () => {
  const dirs = ['', 'packages/ui', 'packages/ui/fixtures/app', 'apps/loopbot']

  it('is every package directory a file is under, the root included', () => {
    expect(enclosingPackages('packages/ui/fixtures/app/a.ts', dirs)).toEqual([
      '',
      'packages/ui',
      'packages/ui/fixtures/app',
    ])
    expect(enclosingPackages('pnpm-lock.yaml', dirs)).toEqual([''])
  })

  it('does not take a directory that only shares a prefix with the file', () => {
    expect(enclosingPackages('packages/ui-kit/a.ts', ['packages/ui'])).toEqual([])
    expect(enclosingPackages('apps/loopbot/src/a.ts', ['apps/loopbot'])).toEqual(['apps/loopbot'])
  })

  it('is nothing for a file outside every package', () => {
    expect(enclosingPackages('docs/a.md', ['packages/ui'])).toEqual([])
  })
})

describe('isIgnored', () => {
  it('matches a name in the ignore list, exactly', () => {
    expect(isIgnored('loopbot', ['loopbot'])).toBe(true)
    expect(isIgnored('loopbot-cli', ['loopbot'])).toBe(false)
    expect(isIgnored('loopbot', [])).toBe(false)
  })

  it('takes a star as any part of a name without a slash, as in a scope', () => {
    expect(
      isIgnored('@getloopscale/loopzero-example-chat', ['@getloopscale/loopzero-example-*']),
    ).toBe(true)
    expect(isIgnored('@getloopscale/loopzero-ui', ['@getloopscale/loopzero-example-*'])).toBe(false)
    expect(isIgnored('@other/example-chat', ['@getloopscale/loopzero-example-*'])).toBe(false)
    expect(isIgnored('@getloopscale/loopzero-a/b', ['@getloopscale/loopzero-*'])).toBe(false)
  })

  it('reads the other characters of a pattern literally', () => {
    expect(isIgnored('axb', ['a.b'])).toBe(false)
    expect(isIgnored('a.b', ['a.b'])).toBe(true)
  })
})

describe('parseManifest', () => {
  it('reads the name and whether the package is private', () => {
    expect(parseManifest('{"name":"loopbot","private":true}', 'apps/loopbot')).toEqual({
      name: 'loopbot',
      private: true,
    })
    expect(parseManifest('{"name":"@getloopscale/loopzero-ui"}', 'packages/ui')).toEqual({
      name: '@getloopscale/loopzero-ui',
      private: false,
    })
  })

  it('is a package with no name, and not private, when the manifest says neither', () => {
    expect(parseManifest('{"private":"yes"}', 'x')).toEqual({ name: undefined, private: false })
    expect(parseManifest('{"name":5}', 'x')).toEqual({ name: undefined, private: false })
  })

  it('names the file when it is not JSON', () => {
    expect(() => parseManifest('{', 'packages/ui')).toThrow(
      /^packages\/ui\/package.json is not valid JSON/,
    )
    expect(() => parseManifest('{', '')).toThrow(/^package.json is not valid JSON/)
  })
})

describe('changesetIgnore', () => {
  it('reads the ignore list of .changeset/config.json, empty when there is none', () => {
    expect(changesetIgnore('{"ignore":["loopbot"]}')).toEqual(['loopbot'])
    expect(changesetIgnore('{"access":"public"}')).toEqual([])
  })

  it('says which file is not JSON', () => {
    expect(() => changesetIgnore('nope')).toThrow(/^\.changeset\/config.json is not valid JSON/)
  })
})

describe('publishedTouched', () => {
  const manifests = new Map([
    ['', { name: 'loopzero-monorepo', private: true }],
    ['packages/ui', { name: '@getloopscale/loopzero-ui', private: false }],
    ['packages/sdk', { name: '@getloopscale/loopzero-sdk', private: false }],
    ['apps/loopbot', { name: 'loopbot', private: false }],
    ['apps/site', { name: 'site', private: true }],
    ['apps/unnamed', { name: undefined, private: false }],
  ])

  it('is nothing when every change is in an ignored or private package, or at the private root', () => {
    expect(
      publishedTouched(
        ['apps/loopbot/src/a.ts', 'apps/site/page.tsx', 'pnpm-lock.yaml', 'apps/unnamed/x.ts'],
        manifests,
        ['loopbot'],
      ),
    ).toEqual([])
  })

  it('names each published package a change touches, once and in order', () => {
    expect(
      publishedTouched(
        ['packages/ui/b.ts', 'apps/loopbot/a.ts', 'packages/sdk/x.ts', 'packages/ui/a.ts'],
        manifests,
        ['loopbot'],
      ),
    ).toEqual(['@getloopscale/loopzero-sdk', '@getloopscale/loopzero-ui'])
  })

  it('counts a file of a package nested in a published one as a change to the published one', () => {
    const nested = new Map([
      ...manifests,
      ['packages/ui/fixtures/app', { name: 'fixture', private: true }],
    ])
    expect(publishedTouched(['packages/ui/fixtures/app/a.ts'], nested, [])).toEqual([
      '@getloopscale/loopzero-ui',
    ])
  })

  it('takes a published root package, as in a repository that is one package', () => {
    const single = new Map([['', { name: 'tool', private: false }]])
    expect(publishedTouched(['src/a.ts'], single, [])).toEqual(['tool'])
  })

  it('is nothing for a file in no package', () => {
    expect(publishedTouched(['docs/a.md'], new Map(), [])).toEqual([])
  })
})

describe('pickVersionSuccessor', () => {
  const pr = (over: Record<string, unknown> = {}) => ({
    number: 190,
    url: 'u',
    headSha: 's',
    headRef: 'changeset-release/main',
    headRepo: 'o/r',
    baseRef: 'main',
    draft: false,
    ...over,
  })
  const branches = { repo: 'o/r', release: 'main' }

  it('takes the open pull request from the version branch of the release branch, in the repository', () => {
    expect(pickVersionSuccessor([pr()], branches, 180)?.number).toBe(190)
  })

  it('ignores the recorded one, a fork, another base and another head', () => {
    expect(pickVersionSuccessor([pr({ number: 180 })], branches, 180)).toBeUndefined()
    expect(pickVersionSuccessor([pr({ headRepo: 'x/r' })], branches, 180)).toBeUndefined()
    expect(pickVersionSuccessor([pr({ baseRef: 'develop' })], branches, 180)).toBeUndefined()
    expect(pickVersionSuccessor([pr({ headRef: 'feature' })], branches, 180)).toBeUndefined()
  })
})

describe('noReleasesRead', () => {
  const merged = new Date('2026-11-11T12:00:00Z')

  it('waits inside the window and fails past it, naming the pull request', () => {
    expect(noReleasesRead(merged, new Date(merged.getTime() + 60_000), 180)).toEqual({
      wait: 'waiting for the release workflow to publish',
    })
    const end = noReleasesRead(merged, new Date(merged.getTime() + VERSION_RELEASES_WAIT_MS), 180)
    expect(end).toMatchObject({ failed: expect.stringContaining('#180') })
  })
})

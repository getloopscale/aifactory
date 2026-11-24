import { describe, expect, it } from 'vitest'

import { advisoriesAdded, parseAudit, secretsAdded } from './security-scan'

const key = 'AKIA' + 'ABCDEFGHIJKLMNOP'
const patch = (added: string) =>
  `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -3,0 +4,2 @@\n+const ok = 1\n+${added}\n`

describe('secretsAdded', () => {
  it('blocks an AWS key with its file and line', () => {
    const found = secretsAdded(patch(`const k = "${key}"`))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ severity: 'blocker', file: 'src/a.ts:5' })
  })
  it('ignores removed lines, the documented example and a clean change', () => {
    expect(secretsAdded(patch('const k = 1'))).toEqual([])
    expect(secretsAdded(patch('k = "AKIAIOSFODNN7EXAMPLE"'))).toEqual([])
    expect(secretsAdded(`--- a/x\n+++ b/x\n@@ -1 +0,0 @@\n-${key}\n`)).toEqual([])
  })
  it('finds a private key header', () => {
    const header = '-----BEGIN ' + 'RSA PRIVATE KEY-----'
    expect(secretsAdded(patch(header))).toHaveLength(1)
  })
})

describe('advisoriesAdded', () => {
  const audit = (...a: { id: string; severity: string }[]) =>
    JSON.stringify({
      advisories: Object.fromEntries(
        a.map((x, i) => [
          i,
          { github_advisory_id: x.id, module_name: 'picomatch', severity: x.severity },
        ]),
      ),
    })
  it('blocks a high advisory the base lacks', () => {
    const found = advisoriesAdded(audit(), audit({ id: 'GHSA-fc5q-39xc-vjpf', severity: 'high' }))
    expect(found).toHaveLength(1)
    expect(found[0].issue).toContain('GHSA-fc5q-39xc-vjpf')
  })
  it('ignores one the base has and a low one', () => {
    const a = audit({ id: 'GHSA-1', severity: 'high' })
    expect(advisoriesAdded(a, a)).toEqual([])
    expect(advisoriesAdded(audit(), audit({ id: 'GHSA-2', severity: 'low' }))).toEqual([])
  })
  it('reads the npm v7 shape', () => {
    const npm = JSON.stringify({
      vulnerabilities: {
        vite: { via: ['picomatch', { url: 'https://x/GHSA-9', severity: 'critical' }] },
      },
    })
    expect(parseAudit(npm)).toEqual([{ id: 'https://x/GHSA-9', pkg: 'vite', severity: 'critical' }])
  })
  it('is one blocker when an audit cannot be read', () => {
    expect(advisoriesAdded('not json', audit())).toHaveLength(1)
    expect(advisoriesAdded(audit(), '{}')).toHaveLength(1)
  })
})

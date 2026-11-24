import type { GithubApi } from '../github/pulls'

/** A package.json that is published and says another version than the tag to be pushed. */
export type ManifestMismatch = { path: string; version: string }

/**
 * The manifests at `ref` that a tag workflow would publish and that do not carry the version of `tag`
 * (`v1.2.3` is `1.2.3`). A private manifest, or one with no name or version, publishes nothing, so it is
 * not compared. A manifest that cannot be read throws: the refusal is never a guess.
 */
export async function manifestsOutOfStep(
  api: GithubApi,
  input: { repo: string; token: string; ref: string; tag: string },
): Promise<ManifestMismatch[]> {
  const { repo, token, ref } = input
  const wanted = input.tag.replace(/^v/, '')
  const paths = (await api.filePaths(repo, token, ref)).filter(
    (path) =>
      (path === 'package.json' || path.endsWith('/package.json')) &&
      !path.split('/').includes('node_modules'),
  )
  const out: ManifestMismatch[] = []
  for (const path of paths) {
    const text = await api.readFile(repo, token, path, ref)
    if (text === undefined) throw new Error(`${path} is not on ${ref} of ${repo}`)
    let manifest: { name?: unknown; version?: unknown; private?: unknown }
    try {
      manifest = JSON.parse(text)
    } catch {
      throw new Error(`${path} on ${ref} of ${repo} is not valid JSON`)
    }
    if (!manifest || typeof manifest !== 'object' || manifest.private === true) continue
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') continue
    if (manifest.version !== wanted) out.push({ path, version: manifest.version })
  }
  return out
}

/** The refusal's reason: names each manifest and the version the tag needs. */
export function manifestRefusal(tag: string, ref: string, found: ManifestMismatch[]): string {
  const list = found.map((m) => `${m.path} says ${m.version}`).join(', ')
  return `the release would be tagged ${tag}, but ${list} at ${ref.slice(0, 7)}: set the version to ${tag.replace(/^v/, '')} first, or the workflow that publishes the tag will refuse it`
}

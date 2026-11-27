import type { SandboxBackend } from '@getloopscale/loopzero-agents/sandbox'
import { and, asc, eq, lt } from 'drizzle-orm'

import type { Database } from '../db'
import { evidence, evidenceArtifact } from '../db/schema'

import type { CheckResult } from './evidence'

/** What a check may carry out of the sandbox, per attempt. */
export const MAX_ARTIFACT_FILES = 20
export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024
/** How many files discovery lists before it stops, so a check that writes a million files costs nothing. */
const MAX_LISTED = 500

export type CapturedArtifact = { path: string; contentType: string; content: Buffer }

export type Captured = {
  artifacts: CapturedArtifact[]
  /** What was left out and why, in words the owner reads. */
  omitted: string[]
}

/** A declared path is relative to the repository, with no `..`, no absolute start and no control characters. */
export function safeArtifactPath(path: string): boolean {
  if (path === '' || path.length > 200 || path.startsWith('/') || path.startsWith('-')) return false
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return false
  return !path.split('/').includes('..')
}

const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  txt: 'text/plain',
  log: 'text/plain',
  json: 'application/json',
  zip: 'application/zip',
}

/** The type a file is offered as. Anything else, HTML included, is bytes to download, never rendered. */
export function artifactContentType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return TYPES[ext] ?? 'application/octet-stream'
}

/** Types the panel may show in the page; every other is served as a download. */
export function inlineSafe(contentType: string): boolean {
  return /^(image\/(png|jpeg|gif|webp)|video\/(mp4|webm))$/.test(contentType)
}

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

/**
 * Copies the declared files out of the checkout, within the limits. Symlinks are not followed, a file that
 * resolves outside the checkout is skipped, and a failure to read is an omission: it never changes a verdict.
 */
export async function collectArtifacts(
  backend: SandboxBackend,
  repoDir: string,
  declared: string[],
): Promise<Captured> {
  const out: Captured = { artifacts: [], omitted: [] }
  const paths = declared.filter((p) => {
    const ok = safeArtifactPath(p)
    if (!ok) out.omitted.push(`${p}: not a path inside the repository`)
    return ok
  })
  if (paths.length === 0) return out
  try {
    const list = await backend.execute(
      `cd ${quote(repoDir)} && for p in ${paths.map(quote).join(' ')}; do ` +
        `find -P "$p" -type f -printf '%s\\t%p\\n' 2>/dev/null; done | head -n ${MAX_LISTED + 1}`,
      { timeoutMs: 30_000 },
    )
    const seen = new Set<string>()
    const files: { size: number; path: string }[] = []
    for (const line of list.stdout.split('\n')) {
      const tab = line.indexOf('\t')
      if (tab < 0) continue
      const path = line.slice(tab + 1)
      const size = Number(line.slice(0, tab))
      if (!Number.isFinite(size) || seen.has(path) || !safeArtifactPath(path)) continue
      seen.add(path)
      files.push({ size, path })
    }
    if (files.length > MAX_LISTED) {
      out.omitted.push(`more than ${MAX_LISTED} files were declared; the rest were not listed`)
      files.length = MAX_LISTED
    }
    files.sort((a, b) => a.path.localeCompare(b.path))
    let total = 0
    for (const file of files) {
      if (out.artifacts.length >= MAX_ARTIFACT_FILES) {
        out.omitted.push(`${file.path}: over the limit of ${MAX_ARTIFACT_FILES} files`)
      } else if (total + file.size > MAX_ARTIFACT_BYTES) {
        out.omitted.push(
          `${file.path}: ${file.size} bytes do not fit in the ${MAX_ARTIFACT_BYTES} byte limit`,
        )
      } else {
        const content = await readFile(backend, repoDir, file)
        if (content) {
          total += content.length
          out.artifacts.push({
            path: file.path,
            contentType: artifactContentType(file.path),
            content,
          })
        } else out.omitted.push(`${file.path}: could not be read`)
      }
    }
  } catch (error) {
    out.omitted.push(
      `capture failed: ${String(error instanceof Error ? error.message : error).slice(0, 200)}`,
    )
  }
  return out
}

async function readFile(
  backend: SandboxBackend,
  repoDir: string,
  file: { size: number; path: string },
): Promise<Buffer | undefined> {
  const p = quote(file.path)
  // The real path must stay inside the checkout (a link in a directory of the path could lead out of it), and
  // the read is bounded by the size that was listed.
  const run = await backend.execute(
    `cd ${quote(repoDir)} && r="$(realpath -e -- ${p})" && case "$r" in "$(realpath .)"/*) head -c ${file.size} -- ${p} | base64 -w0;; *) exit 3;; esac`,
    { timeoutMs: 60_000 },
  )
  if (run.exitCode !== 0) return undefined
  const content = Buffer.from(run.stdout.trim(), 'base64')
  return content.length === file.size ? content : undefined
}

/** Stores a check's result as evidence for the commit, with the files it wrote beside it. */
export async function storeEvidence(
  db: Database,
  taskId: number,
  sha: string,
  result: CheckResult,
): Promise<void> {
  const { artifacts = [], omitted = [], ...row } = result
  const values = db.insert(evidence).values({ taskId, sha, ...row, omitted })
  // Only a result with files needs the row's id back.
  if (artifacts.length === 0) {
    await values
    return
  }
  const [stored] = await values.returning({ id: evidence.id })
  if (!stored) return
  for (const file of artifacts) {
    await db.insert(evidenceArtifact).values({
      evidenceId: stored.id,
      taskId,
      sha,
      path: file.path,
      contentType: file.contentType,
      sizeBytes: file.content.length,
      content: file.content,
    })
  }
}

/** Deletes the files older than the retention of the transcripts, and says how many went. */
export async function pruneArtifacts(db: Database, before: Date): Promise<number> {
  const gone = await db
    .delete(evidenceArtifact)
    .where(lt(evidenceArtifact.at, before))
    .returning({ id: evidenceArtifact.id })
  return gone.length
}

/**
 * The headers a file is served with: a type from a short list that cannot run in a page, a download for anything
 * else, no sniffing, and a policy that lets nothing in it load or run.
 */
export function artifactHeaders(path: string, contentType: string): Record<string, string> {
  const inline = inlineSafe(contentType)
  const name = (path.split('/').pop() ?? 'artifact').replace(/[^A-Za-z0-9._-]/g, '_')
  return {
    'content-type': inline ? contentType : 'application/octet-stream',
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${name}"`,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'cache-control': 'private, no-store',
  }
}

/** The files stored for a commit of a task, oldest first. */
export async function artifactsAt(
  db: Database,
  taskId: number,
  sha: string,
): Promise<{ id: number; path: string }[]> {
  return db
    .select({ id: evidenceArtifact.id, path: evidenceArtifact.path })
    .from(evidenceArtifact)
    .where(and(eq(evidenceArtifact.taskId, taskId), eq(evidenceArtifact.sha, sha)))
    .orderBy(asc(evidenceArtifact.id))
}

/**
 * The files of the latest verification: the checks run on the newest commit that has evidence, so the files of
 * older commits (a commit the work has since moved on from) are not shown as the current proof.
 */
export function ofLatestVerification<F extends { evidenceId: number }>(
  checks: { id: number; sha: string }[],
  files: F[],
): F[] {
  const latest = checks.at(-1)?.sha
  const ids = new Set(checks.filter((c) => c.sha === latest).map((c) => c.id))
  return files.filter((f) => ids.has(f.evidenceId))
}

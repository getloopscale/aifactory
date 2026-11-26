import type { SandboxBackend } from '@theokit/agents/sandbox'

import { unplannedFiles, type ChangePlan } from './change-plan'
import { MAX_PATHS, parseNumstat, type ChangeSize } from './change-size'
import { changesetPackages, isChangesetFile } from './changesets'
import { diffGuards, parseNameStatus, testScriptOf } from './guards'
import type { Finding } from './review'
import {
  repairedChecks,
  withoutRequired,
  type CheckRun,
  type RequiredByCheck,
} from './required-files'
import { must } from './run-support'
import { securitySurfaces } from './security-review'
import { auditBlockers, secretsAdded } from './security-scan'
import { TEST_PATHSPECS } from './test-weakening'

export type DiffFacts = {
  guards: Finding[]
  /** The changed files the plan does not name and no repaired check accounts for. */
  unplanned: string[]
  /** The factory checks that failed on an earlier commit of the change and pass on HEAD. */
  required: RequiredByCheck[]
  /** Every path the change touches, the old path of a rename included. */
  touched: string[]
  /** The size of the change, and the paths that count in it (#474), for the commit measured. */
  size: ChangeSize & { paths: string[] }
}

/**
 * What the change on HEAD says about itself, without a model: facts an agent could bend, and the files it
 * changed that the plan does not name. The change is measured from the merge base of `baseSha` and HEAD,
 * which is what the reviewer reads (`git diff baseSha...HEAD`) and what GitHub shows on the pull request.
 * On a first run that is `baseSha` itself. On a task sent back, `baseSha` is the integration branch as it
 * is now and HEAD is the branch cut from it earlier, and what the integration branch changed since then is
 * not the agent's (getloopscale/aifactory#38).
 *
 * `checkRuns` is every result of the factory's checks on this task. A file added between the commit a check
 * failed on and the commit it then passed on is what the check asked for, so it is not listed as outside
 * the plan (getloopscale/aifactory#53), unless it is a changeset that names no package. The guards read the whole diff either way.
 */
export async function diffFacts(
  backend: SandboxBackend,
  repoDir: string,
  input: {
    baseSha: string
    plan: ChangePlan | undefined
    issue: { labels: string[]; title: string; body: string }
    checkRuns?: CheckRun[]
  },
): Promise<DiffFacts> {
  const git = `git -C ${repoDir}`
  const base = (await must(backend, `${git} merge-base ${input.baseSha} HEAD`)).stdout.trim()
  const nameStatus = (await must(backend, `${git} diff --name-status ${base} HEAD`)).stdout
  const changes = parseNameStatus(nameStatus)
  const showScript = async (rev: string) => {
    const shown = await backend.execute(`${git} show ${rev}:package.json`)
    return shown.exitCode === 0 ? testScriptOf(shown.stdout) : undefined
  }
  // Fixed pathspecs only: no path the agent wrote reaches the shell.
  const tests = await must(
    backend,
    `${git} diff -U0 --no-color --no-renames ${base} HEAD -- ${TEST_PATHSPECS.join(' ')}`,
  )
  const guards = diffGuards({
    changes,
    baseTestScript: await showScript(base),
    headTestScript: await showScript('HEAD'),
    tests: { patch: tests.stdout, issue: input.issue },
  })
  // The deterministic floor of the security review: a secret the change adds blocks it, whatever the reviewer says.
  guards.push(
    ...(await securityFloor(
      backend,
      repoDir,
      base,
      changes.map((change) => change.path),
    )),
  )
  const paths = changes.map((change) => change.path)
  const required = await requiredByChecks(backend, git, base, input.checkRuns ?? [])
  const unplanned = input.plan ? unplannedFiles(paths, input.plan) : []
  const touched = nameStatus
    .split('\n')
    .flatMap((line) => line.split('\t').slice(1))
    .filter((path) => path !== '')
  const numstat = await must(backend, `${git} diff --numstat --no-color --no-renames ${base} HEAD`)
  const measured = parseNumstat(numstat.stdout)
  const size = { ...measured.size, paths: measured.paths.slice(0, MAX_PATHS) }
  return { guards, unplanned: withoutRequired(unplanned, required), required, touched, size }
}

/**
 * The deterministic floor of the security review (#241) on the change from `base` to HEAD: the secrets it adds
 * and the audit blockers of the packages it touches. The review reads it as a guard, and the security step
 * (`Run.secured`) reads it again before an approval can merge, so a kept approval cannot skip it.
 */
export async function securityFloor(
  backend: SandboxBackend,
  repoDir: string,
  base: string,
  paths?: string[],
): Promise<Finding[]> {
  const git = `git -C ${repoDir}`
  const added = await must(backend, `${git} diff -U0 --no-color --no-renames ${base} HEAD`)
  const touched =
    paths ??
    parseNameStatus((await must(backend, `${git} diff --name-status ${base} HEAD`)).stdout).map(
      (change) => change.path,
    )
  return [...secretsAdded(added.stdout), ...(await auditBlockers(backend, repoDir, base, touched))]
}

/** The security surfaces the change from `base` to HEAD touches; none means the floor alone decides (#457). */
export async function securitySurfacesOf(
  backend: SandboxBackend,
  repoDir: string,
  base: string,
): Promise<string[]> {
  const git = `git -C ${repoDir}`
  const names = await must(backend, `${git} diff --name-only --no-renames ${base} HEAD`)
  const patch = await must(backend, `${git} diff -U0 --no-color --no-renames ${base} HEAD`)
  return securitySurfaces({
    touched: names.stdout.split('\n').filter((p) => p !== ''),
    patch: patch.stdout,
  })
}

/** The most of the patch the security prompt carries; the rest is left to a read of the file. */
const SECURITY_DIFF_MAX = 60_000

/**
 * What the security agent is handed (#457): the files the change touches and its patch, cut at a limit, so it
 * judges the change instead of exploring the repository.
 */
export async function securityDiff(
  backend: SandboxBackend,
  repoDir: string,
  base: string,
): Promise<string> {
  const git = `git -C ${repoDir}`
  const stat = await must(backend, `${git} diff --stat --no-color ${base} HEAD`)
  const patch = await must(backend, `${git} diff -U3 --no-color --no-renames ${base} HEAD`)
  return `${stat.stdout.trim()}\n\n${cutPatch(patch.stdout, SECURITY_DIFF_MAX)}`
}

/**
 * The patch cut at a file boundary when it exceeds `max`, with every file left out named, so the agent knows what
 * it did not see and reads it. A first file longer than `max` is cut inside and named too.
 */
export function cutPatch(patch: string, max: number): string {
  if (patch.length <= max) return patch
  const files = patch.split(/^(?=diff --git )/m)
  const nameOf = (chunk: string) => /^diff --git a\/(.+?) b\//.exec(chunk)?.[1] ?? '(unnamed file)'
  let kept = ''
  const left: string[] = []
  for (const chunk of files) {
    if (left.length === 0 && kept.length + chunk.length <= max) kept += chunk
    else if (left.length === 0 && kept === '') {
      kept = chunk.slice(0, max)
      left.push(`${nameOf(chunk)} (cut inside)`)
    } else left.push(nameOf(chunk))
  }
  return `${kept}\n[the patch is cut here; read these files with read_file: ${left.join(', ')}]`
}

/** A branch name with nothing a shell reads as more than a name. */
const PLAIN_BRANCH = /^[\w.][\w./-]*$/

/**
 * Where the change on HEAD starts, measured again before each review: the merge base of HEAD and the head of
 * the integration branch as it is now, fetched. The head the run cloned (`baseSha`) goes stale once the work
 * branch merges the integration branch after it moved, and the diff from it then holds other tasks' commits,
 * which the review reads as changes outside the plan. When the fetched head shares no commit with HEAD, the
 * cloned head stays the base.
 */
export async function reviewBase(
  backend: SandboxBackend,
  repoDir: string,
  input: { baseSha: string; integration: string },
): Promise<string> {
  const git = await fetchIntegration(backend, repoDir, input.integration)
  const merged = await backend.execute(`${git} merge-base FETCH_HEAD HEAD`)
  // git answers 1, and prints nothing, for two commits with no common ancestor; anything else is an error.
  if (merged.exitCode !== 0 && merged.exitCode !== 1) {
    throw new Error(`git merge-base exited ${merged.exitCode}: ${merged.stderr.trim().slice(-500)}`)
  }
  return merged.stdout.trim() || input.baseSha
}

const COMMIT_HASH = /^[0-9a-f]{7,64}$/

/** Fetches the integration branch into `FETCH_HEAD`, and answers the git command prefix for `repoDir`. */
async function fetchIntegration(
  backend: SandboxBackend,
  repoDir: string,
  integration: string,
): Promise<string> {
  if (!PLAIN_BRANCH.test(integration)) {
    throw new Error(
      `the integration branch ${JSON.stringify(integration)} is not a plain branch name, so it is not handed to a shell`,
    )
  }
  const git = `git -C ${repoDir}`
  await must(backend, `${git} fetch -q origin ${integration}`)
  return git
}

/**
 * Whether `head` carries the same change as `approved`, each measured from where it meets the head of the
 * integration branch, fetched (`git patch-id --stable`). A merge of the integration branch that conflicted
 * nowhere and changed nothing the task wrote leaves the patch as it was, so the review of `approved` still
 * reads what `head` changes. A patch that cannot be measured, or an empty one, is never the same.
 */
export async function samePatch(
  backend: SandboxBackend,
  repoDir: string,
  input: { integration: string; approved: string; head: string },
): Promise<boolean> {
  for (const sha of [input.approved, input.head]) {
    if (!COMMIT_HASH.test(sha)) throw new Error(`${JSON.stringify(sha)} is not a commit hash`)
  }
  const git = await fetchIntegration(backend, repoDir, input.integration)
  const patchOf = async (sha: string): Promise<string> => {
    const base = (await must(backend, `${git} merge-base FETCH_HEAD ${sha}`)).stdout.trim()
    if (!COMMIT_HASH.test(base)) return ''
    const id = await must(backend, `${git} diff ${base} ${sha} | ${git} patch-id --stable`)
    return id.stdout.trim().split(/\s+/)[0] ?? ''
  }
  const before = await patchOf(input.approved)
  return before !== '' && before === (await patchOf(input.head))
}

/** The repaired checks of the change on HEAD, each with the files added while it was repaired. */
async function requiredByChecks(
  backend: SandboxBackend,
  git: string,
  base: string,
  runs: CheckRun[],
): Promise<RequiredByCheck[]> {
  if (runs.every((run) => run.passed)) return []
  const commits = (await must(backend, `${git} rev-list ${base}..HEAD`)).stdout
    .split('\n')
    .filter(Boolean)
  const required: RequiredByCheck[] = []
  // Both commits are among those `rev-list` printed, so no stored text reaches the shell.
  for (const check of repairedChecks(runs, commits)) {
    const added = await must(
      backend,
      `${git} diff --name-only --diff-filter=A --no-renames ${check.failedSha} ${check.passedSha}`,
    )
    const files = added.stdout.split('\n').filter(Boolean)
    required.push({ ...check, files: await calledFor(backend, git, check.passedSha, files) })
  }
  return required
}

/** A changeset path with nothing a shell reads as more than a name. */
const PLAIN_CHANGESET = /^\.changeset\/[\w.-]+\.md$/

/**
 * The added files a check can have asked for: all of them but a changeset that names no package. No check
 * asks for one of those (the factory's own fails on it), and it breaks the release of the repository
 * (getloopscale/aifactory#67), so it stays among the files outside the plan and the reviewer is not
 * told it is legitimate. A changeset is read at the commit the check passed on, and only when its path is
 * plain: one with any other character is not handed to a shell, and is not taken as asked for either.
 */
async function calledFor(
  backend: SandboxBackend,
  git: string,
  sha: string,
  files: string[],
): Promise<string[]> {
  const kept: string[] = []
  for (const file of files) {
    if (!isChangesetFile(file)) kept.push(file)
    else if (PLAIN_CHANGESET.test(file)) {
      const shown = await must(backend, `${git} show ${sha}:${file}`)
      if (changesetPackages(shown.stdout).length > 0) kept.push(file)
    }
  }
  return kept
}

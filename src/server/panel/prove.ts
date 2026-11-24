import { and, sql } from 'drizzle-orm'

import type { ChecksProof, ProofKind, SandboxProviderName } from '../../shared/panel'
import type { Database } from '../db'
import { repository } from '../db/schema'
import { DEFAULT_CHECK_MS } from '../factory/agent-time'
import type { CheckSpec } from '../factory/evidence'
import {
  effectiveChecks,
  kindOf,
  passedChecks,
  proofView,
  proveChecks,
  type Proof,
  type ProveDeps,
  type ProveOptions,
} from '../factory/prove-checks'
import { loadRepoConfig } from '../factory/repo-config'

import { ActionRefused } from './actions'
import { savedName } from './recipe'
import { patchProblem } from './work'

/**
 * What the `prove-checks` job is given: the repository and the proof it is for, named by its time and its
 * kind. A job queued before proofs had a kind is for the repository's checks.
 */
export type ProofJob = { repository: string; at: string; kind?: ProofKind }

export type StartProofDeps = {
  db: Database
  now?: () => Date
  /** Runs `work` in a transaction, with `prove-checks` queued through that transaction. */
  inTransaction: <T>(
    work: (tx: Database, enqueue: (job: ProofJob) => Promise<void>) => Promise<T>,
  ) => Promise<T>
}

export type RunProofDeps = ProveDeps & {
  db: Database
  /** The sandbox provider the proof runs on, to keep what it found for that provider. */
  provider?: SandboxProviderName
  /** Examines the repository again after its checks changed: the doctor, whose report names them. */
  diagnose?: (fullName: string) => Promise<unknown>
}

const named = (fullName: string) => sql`lower(${repository.fullName}) = lower(${fullName})`

/**
 * The columns each kind of proof reads and writes: where the proof is kept, and where what passed is saved
 * with the commit it passed on.
 */
const COLUMNS = {
  checks: {
    proof: 'checksProof',
    proven: 'checksProven',
    list: 'checks',
    sha: 'checksProvenSha',
  },
  integration: {
    proof: 'integrationChecksProof',
    proven: 'integrationChecksProven',
    list: 'integrationChecks',
    sha: 'integrationChecksProvenSha',
  },
} as const satisfies Record<ProofKind, Record<string, keyof typeof repository.$inferSelect>>

/**
 * What a proof of each kind runs before the proposed checks. Integration checks run on the merge of the
 * work in a run, after the repository's checks installed the project, so their proof does the same.
 */
const OPTIONS: Record<ProofKind, ProveOptions> = {
  checks: {},
  integration: { setup: effectiveChecks },
}

/**
 * Asks for the proposed checks to be proven, as the repository's checks or as its integration checks. The
 * proposal is kept on the repository as a proof that is `proving`, and the job that runs it is queued in
 * the same transaction; nothing is saved until a check has passed. A proof asked for while another of the
 * same kind runs replaces it; one of the other kind is left alone.
 */
export async function startProof(
  deps: StartProofDeps,
  fullName: string,
  checks: CheckSpec[],
  kind: ProofKind = 'checks',
): Promise<ChecksProof> {
  const name = await savedName(deps.db, fullName)
  if (checks.length === 0) throw new ActionRefused('propose at least one check to prove')
  const problem = patchProblem({ [COLUMNS[kind].list]: checks }, [])
  if (problem) throw new ActionRefused(problem)
  const proof: ChecksProof = {
    fullName: name,
    kind,
    status: 'proving',
    at: (deps.now?.() ?? new Date()).toISOString(),
    checks: checks.map((check) => ({ name: check.name, command: check.command.trim() })),
    sha: null,
    limitMs: DEFAULT_CHECK_MS,
    results: [],
    saved: [],
    error: null,
  }
  return deps.inTransaction(async (tx, enqueue) => {
    await tx
      .update(repository)
      .set({ [COLUMNS[kind].proof]: proof })
      .where(named(name))
    await enqueue({ repository: name, at: proof.at, kind })
    return proof
  })
}

/**
 * The last proof of one kind of a repository the factory knows, as it is shown; null when none was asked
 * for.
 */
export async function readProof(
  db: Database,
  fullName: string,
  now: Date,
  kind: ProofKind = 'checks',
): Promise<ChecksProof | null> {
  const name = await savedName(db, fullName)
  const [row] = await db
    .select({ proof: repository[COLUMNS[kind].proof] })
    .from(repository)
    .where(named(name))
  return proofView(row.proof, now)
}

type Settled = Partial<typeof repository.$inferInsert>

/** The finished proof and what of it becomes the repository's checks of its kind: only what passed. */
function settled(proof: ChecksProof, found: Proof): Settled {
  const columns = COLUMNS[proof.kind]
  const passed = passedChecks(found.results)
  const done: ChecksProof = {
    ...proof,
    status: 'done',
    sha: found.sha,
    limitMs: found.limitMs,
    results: found.results,
    saved: passed.map((check) => check.name),
    ...(found.setup ? { setup: found.setup } : {}),
  }
  if (passed.length === 0) return { [columns.proof]: done }
  return {
    [columns.proof]: done,
    [columns.list]: passed.map(({ name, command }) => ({ name, command })),
    [columns.proven]: passed,
    [columns.sha]: found.sha,
    updatedAt: new Date(),
  }
}

/** A proof that could not run, with the reason, as it is kept. */
function unrun(proof: ChecksProof, error: unknown): Settled {
  const reason = error instanceof Error ? error.message : String(error)
  return {
    [COLUMNS[proof.kind].proof]: { ...proof, status: 'failed', error: reason.slice(0, 600) },
  }
}

/**
 * Runs a proof that was asked for and keeps what it found. The checks that passed become the
 * repository's checks of the proof's kind, with the commit they passed on; one that failed or was too slow
 * is kept only in the proof, with its output, and when none passed the saved checks stay as they were. A
 * proof that could not run is recorded as failed with the reason, as a plan is: nobody retries it from a
 * queue. Whatever is written is written only while this proof is still the repository's last of its kind.
 * The doctor examines the repository again after its checks changed or a provider's result was recorded, since
 * its report names them and not the integration checks.
 */
export async function runProof(deps: RunProofDeps, job: ProofJob): Promise<void> {
  const { db } = deps
  const kind = kindOf(job)
  const column = COLUMNS[kind].proof
  const [row] = await db.select().from(repository).where(named(job.repository))
  const stored = row?.[column]
  if (!stored || stored.status !== 'proving' || stored.at !== job.at) return
  const proof: ChecksProof = { ...stored, kind }

  let values: Settled
  try {
    const config = await loadRepoConfig(db, row.fullName)
    const repo = { fullName: row.fullName, config }
    const found = await proveChecks(deps, repo, proof.checks, OPTIONS[kind])
    values = settled(proof, found)
    if (kind === 'checks' && deps.provider) {
      values.checksProofByProvider = {
        ...(row.checksProofByProvider ?? {}),
        [deps.provider]: {
          at: new Date().toISOString(),
          sha: found.sha,
          passed: found.results.filter((r) => r.status === 'passed').map((r) => r.name),
          failed: found.results.filter((r) => r.status !== 'passed').map((r) => r.name),
        },
      }
    }
  } catch (error) {
    values = unrun(proof, error)
  }
  const written = await db
    .update(repository)
    .set(values)
    .where(and(named(row.fullName), sql`${repository[column]}->>'at' = ${job.at}`))
    .returning({ id: repository.id })
  if (
    written.length > 0 &&
    kind === 'checks' &&
    ('checks' in values || 'checksProofByProvider' in values)
  ) {
    await deps.diagnose?.(row.fullName)
  }
}

import type { SandboxBackend } from '@theokit/agents/sandbox'

import { whenSlotFree } from './sandbox-slot'

/** A destination the sandbox may reach, optionally with headers the firewall attaches to it. */
export type EgressRule = {
  domain: string
  /** Attached outside the sandbox, so code running in it never sees the values. */
  headers?: Record<string, string>
}

/** Who a sandbox belongs to, so a sandbox whose owner is gone can be told from one in use. */
export type SandboxOwner =
  | { owner: 'task'; taskId: number; run: string }
  | { owner: 'eval'; caseId: string; runId: string }
  | { owner: 'prove-checks'; repository: string }
  | { owner: 'plan'; planId: number }

/** A sandbox as the provider lists it: what it was created with, and when. */
export type ListedSandbox = { id: string; startedAt: Date; metadata: Record<string, string> }

export type SandboxSpec = {
  /** Recorded on the sandbox when the provider can, so a listing says who owns it. */
  owner?: SandboxOwner
  /** The only destinations the sandbox can reach. */
  egress: EgressRule[]
  timeoutMs: number
  /**
   * What to keep between the sandboxes of one repository (the repository's name): a package manager's
   * downloads, so the next sandbox does not fetch them again. A provider that cannot keeps nothing.
   */
  cacheKey?: string
}

export type ExecuteResult = Awaited<ReturnType<SandboxBackend['execute']>>

export type StreamingOptions = { timeoutMs?: number; onStdoutLine: (line: string) => void }

/**
 * A backend that can also hand over a command's output line by line while it runs. `SandboxBackend`
 * only returns it at the end (usetheokit/theokit-sdk#883), so a provider that can adds this, and a
 * caller asks `streams` before using it.
 */
export type StreamingBackend = SandboxBackend & {
  executeStreaming(command: string, opts: StreamingOptions): Promise<ExecuteResult>
}

export const streams = (backend: SandboxBackend): backend is StreamingBackend =>
  typeof (backend as Partial<StreamingBackend>).executeStreaming === 'function'

/** A file to write into a sandbox: its absolute path there and what it holds. */
export type SandboxFile = { path: string; content: string | Buffer }

/**
 * A backend that can write many files at once. `SandboxBackend` writes one file per call
 * (usetheokit/theokit-sdk#1279), and on E2B each call costs about half a second, so the knowledge base of a
 * large project (nearly a thousand files) took most of a run's preparation. A provider that can adds this, and
 * a caller asks `uploadsInBatch` before using it. It is for paths that do not exist yet: unlike `uploadFile`,
 * it removes nothing first.
 */
export type BatchUploadBackend = SandboxBackend & {
  uploadFiles(files: readonly SandboxFile[]): Promise<void>
}

export const uploadsInBatch = (backend: SandboxBackend): backend is BatchUploadBackend =>
  typeof (backend as Partial<BatchUploadBackend>).uploadFiles === 'function'

/**
 * A running sandbox: the TheoKit `SandboxBackend` the agent tools and the factory talk to, plus the
 * way to stop it. `SandboxBackend` has no lifecycle and no network policy, so both live here.
 */
export type IsolatedSandbox = {
  backend: SandboxBackend
  stop(): Promise<void>
  /**
   * Saves the disk and stops the sandbox, and returns what `restore` needs. The sandbox is gone
   * afterwards. A provider that cannot do this leaves it out, and a task that asks a question
   * then fails instead of waiting.
   */
  snapshot?(): Promise<string>
  /**
   * Replaces the egress rules while the sandbox runs, so a credential the firewall attaches can be renewed
   * before it expires. The new rules pass the same isolation check as the first ones. A provider that
   * cannot leaves it out, and its runs end before the credentials they started with.
   */
  updateEgress?(egress: EgressRule[]): Promise<void>
}

export interface IsolatedSandboxProvider {
  readonly name: string
  /**
   * The longest a sandbox of this provider may live, when its plan caps it. A run asking for more plans its
   * agent passes against this instead, so the checks and the review still fit before the sandbox stops.
   */
  readonly maxSessionMs?: number
  create(spec: SandboxSpec): Promise<IsolatedSandbox>
  /** A new sandbox with the disk of a snapshot, under the same network rules as any other. */
  restore?(snapshotId: string, spec: SandboxSpec): Promise<IsolatedSandbox>
  /** Frees a snapshot, which costs storage until it is deleted or expires. */
  deleteSnapshot?(snapshotId: string): Promise<void>
  /** The snapshots that still exist, so the supervisor can find ones nothing needs. */
  listSnapshots?(): Promise<{ id: string; createdAt: Date; sizeBytes: number }[]>
  /** Every sandbox the account has up, whoever created it, so the supervisor can stop the ones nobody owns. */
  listSandboxes?(): Promise<ListedSandbox[]>
  /** Stops a sandbox by id. */
  killSandbox?(id: string): Promise<void>
  /** How many sandboxes the account may have up at once, when the plan says. */
  readonly maxSandboxes?: number
}

/** Thrown when a run is asked for without the isolation the factory requires. */
export class IsolationRefused extends Error {
  constructor(reason: string) {
    super(`refusing to run without isolation: ${reason}`)
    this.name = 'IsolationRefused'
  }
}

/** Digits and dots look like valid labels, so an address has to be refused on its own. */
const IP_LITERAL = /^[0-9.]+$/

const DOMAIN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i

/**
 * The factory runs an agent only inside a sandbox whose egress is an explicit list of domains.
 * An empty list, a catch-all, or anything that is not a domain is refused: a catch-all lets
 * traffic without a detectable domain through, and an empty list would mean no policy at all.
 */
export function assertIsolated(spec: SandboxSpec): void {
  if (spec.egress.length === 0) {
    throw new IsolationRefused('the egress allowlist is empty')
  }
  if (!(spec.timeoutMs > 0)) {
    throw new IsolationRefused('the sandbox has no timeout')
  }
  for (const { domain } of spec.egress) {
    // The tracker's host is reached only by the factory's process, with a key the sandbox never holds.
    if (/(^|\.)linear\.app$/i.test(domain)) {
      throw new IsolationRefused(`${JSON.stringify(domain)} is not reachable from a sandbox`)
    }
    if (domain === '*' || IP_LITERAL.test(domain) || !DOMAIN.test(domain)) {
      throw new IsolationRefused(`${JSON.stringify(domain)} is not an allowed destination`)
    }
  }
}

/**
 * Creates a sandbox, after checking the spec. Every run goes through here. While the provider refuses for its
 * concurrent limit, it waits for a slot instead of failing the run: a refused run waited for a retry far longer
 * than a slot takes to free.
 */
export async function createIsolatedSandbox(
  provider: IsolatedSandboxProvider,
  spec: SandboxSpec,
  slot: Parameters<typeof whenSlotFree>[1] = {},
): Promise<IsolatedSandbox> {
  assertIsolated(spec)
  return whenSlotFree(() => provider.create(spec), slot)
}

/**
 * Restores a sandbox from a snapshot, after the same check as a new one, and waits for a slot the same way. Saving
 * the snapshot stopped the run's own sandbox, so another run can take that slot before the restore asks for it.
 */
export async function restoreIsolatedSandbox(
  provider: IsolatedSandboxProvider,
  snapshotId: string,
  spec: SandboxSpec,
  slot: Parameters<typeof whenSlotFree>[1] = {},
): Promise<IsolatedSandbox> {
  assertIsolated(spec)
  const restore = provider.restore?.bind(provider)
  if (!restore) {
    throw new IsolationRefused(`${provider.name} cannot restore a snapshot`)
  }
  return whenSlotFree(() => restore(snapshotId, spec), slot)
}

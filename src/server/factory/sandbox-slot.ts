/** How long a caller waits before it asks for a sandbox again while every slot is taken. */
export const SLOT_WAIT_MS = 30_000
/** A task holds its sandbox for minutes, so one frees well within this; past it the refusal stands. */
export const SLOT_LIMIT_MS = 20 * 60_000

const LIMIT = /maximum number of concurrent/i

/** Whether a sandbox was refused because the provider's concurrent sandboxes are all in use. */
export function isSandboxLimit(error: unknown): boolean {
  return error instanceof Error && LIMIT.test(error.message)
}

/**
 * Creates a sandbox, waiting for a slot while every one the provider allows is in use (#261). A run waited
 * the same way would otherwise fail and wait a retry for a slot that frees within minutes.
 * Any other failure is thrown at once; the refusal is thrown once it has waited `limitMs`, or when it
 * is abandoned.
 */
export async function whenSlotFree<T>(
  create: () => Promise<T>,
  options: {
    now?: () => number
    sleep?: (ms: number) => Promise<void>
    limitMs?: number
    signal?: AbortSignal
  } = {},
): Promise<T> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const until = now() + (options.limitMs ?? SLOT_LIMIT_MS)
  for (;;) {
    try {
      return await create()
    } catch (error) {
      if (!isSandboxLimit(error) || options.signal?.aborted || now() >= until) throw error
      await sleep(SLOT_WAIT_MS)
    }
  }
}

/**
 * The longest a run waits in the queue for a free slot before it asks for a sandbox anyway. Runs hold a slot for up
 * to the run limit of their repository (150 minutes on the slowest), so a queue of them waits longer than
 * `SLOT_LIMIT_MS`; past this something else holds the slots, and the refusal of the create says what.
 */
export const QUEUE_SLOT_LIMIT_MS = 3 * 60 * 60_000

/** What a provider says of its slots: the sandboxes the account has up, and how many it allows. */
export type SlotSource = {
  readonly maxSandboxes?: number
  listSandboxes?(): Promise<unknown[]>
}

export type SlotWait = { waitedMs: number; gaveUp?: true; unread?: string }

/**
 * Waits, before a run enters its first stage, while the account already has as many sandboxes up as it allows
 * (`maxSandboxes`, 10 on E2B unless `E2B_MAX_SANDBOXES` says more), so the run waits in the queue instead of
 * being refused and failing (#341: 15 processes take runs for 10 slots). It counts every
 * sandbox of the account, the evaluation's and the proof's included. A provider that cannot say, or a listing
 * that fails, lets the run go: `whenSlotFree` still waits on a refusal.
 */
export async function untilSlotFree(
  provider: SlotSource,
  options: {
    now?: () => number
    sleep?: (ms: number) => Promise<void>
    limitMs?: number
    signal?: AbortSignal
  } = {},
): Promise<SlotWait> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const started = now()
  const limit = options.limitMs ?? QUEUE_SLOT_LIMIT_MS
  if (!provider.listSandboxes || !provider.maxSandboxes) return { waitedMs: 0 }
  for (;;) {
    let up: number
    try {
      up = (await provider.listSandboxes()).length
    } catch (error) {
      return {
        waitedMs: now() - started,
        unread: error instanceof Error ? error.message : String(error),
      }
    }
    const waitedMs = now() - started
    if (up < provider.maxSandboxes || options.signal?.aborted) return { waitedMs }
    if (waitedMs >= limit) return { waitedMs, gaveUp: true }
    await sleep(SLOT_WAIT_MS)
  }
}

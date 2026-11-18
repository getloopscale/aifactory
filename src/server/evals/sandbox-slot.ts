/** How long a case waits before it asks for a sandbox again while every slot is taken. */
export const SLOT_WAIT_MS = 30_000
/** A task holds its sandbox for minutes, so one frees well within this; past it the refusal stands. */
export const SLOT_LIMIT_MS = 20 * 60_000

const LIMIT = /maximum number of concurrent/i

/** Whether a sandbox was refused because the provider's concurrent sandboxes are all in use. */
export function isSandboxLimit(error: unknown): boolean {
  return error instanceof Error && LIMIT.test(error.message)
}

/**
 * Creates a sandbox, waiting for a slot while the factory's runs hold every one the provider allows (#261).
 * Any other failure is thrown at once; the refusal is thrown once the case has waited `limitMs`, or when it
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

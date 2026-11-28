// The model provider of the panel's assistants, watched at its one seam: the fetch of its provider profile.
//
// The framework drops the provider's answer on the way to the page: a refusal for credit reaches the stream as
// `Anthropic API error: invalid_request (HTTP 400)` and the page as "An error occurred." (the SDK masks every code
// but a missing or malformed key, getloopscale/loopzero has no hook for an agent's provider failure). The profile's
// `transform.fetch` sees the response before the SDK reads it, so the factory classifies it there, keeps only that
// classification and hands the response on untouched. Nothing of the body, and never the key, is kept or logged.
import type { Plugin } from '@getloopscale/loopzero-agents'
import { and, eq, lt } from 'drizzle-orm'

import type { AssistProviderRefusal } from '../../shared/panel'
import { getDb, type Database } from '../db'
import { setting } from '../db/schema'

export const ASSIST_PROVIDER_KEY = 'assist.provider_refusal'

/** The one provider the factory watches: the assistants' default (`assistModel`), on its own key. */
const WATCHED = 'anthropic'

/**
 * Anthropic refusing for the account's credit: `invalid_request_error` with "Your credit balance is too low to
 * access the Anthropic API", or a `billing_error`. Any other answer, a 400 among them, is not this one.
 */
export function isCreditRefusal(status: number, body: string): boolean {
  if (status !== 400 && status !== 402) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return false
  }
  const error = (parsed as { error?: { type?: unknown; message?: unknown } } | null)?.error
  if (error?.type === 'billing_error') return true
  return typeof error?.message === 'string' && /credit balance is too low/i.test(error.message)
}

/** Where the refusal is kept, so every process reads the same one. */
export type RefusalStore = {
  /** The provider refused for credit at `at`. */
  refused: (provider: string, at: Date) => Promise<void>
  /** The provider answered a call that started at `startedAt`: a refusal recorded before it is over. */
  accepted: (provider: string, startedAt: Date) => Promise<void>
}

/**
 * The fetch of a watched provider: the call goes out as it came, the response comes back as it came, and on the
 * way the store learns whether the provider refused for credit or answered.
 */
export function watchedFetch(
  provider: string,
  store: RefusalStore,
  base: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): typeof fetch {
  return async (input, init) => {
    const startedAt = now()
    const response = await base(input, init)
    try {
      if (response.ok) await store.accepted(provider, startedAt)
      else if (isCreditRefusal(response.status, await response.clone().text())) {
        await store.refused(provider, now())
        console.log(
          JSON.stringify({ event: 'assist_provider_refused', provider, reason: 'credit' }),
        )
      }
    } catch (error) {
      // The watch never fails the call: a store that is down only leaves the health page behind.
      console.error(
        JSON.stringify({
          event: 'assist_provider_watch_failed',
          provider,
          error: error instanceof Error ? error.name : 'unknown',
        }),
      )
    }
    return response
  }
}

type Stored = { provider: string; reason: 'credit'; since: string }

/**
 * The refusal kept in `setting`. A repeated refusal keeps when it started and moves `updated_at`; an answer
 * clears only a refusal recorded before its own call started, so an older success never clears a newer refusal.
 */
export function settingStore(db: () => Database = getDb): RefusalStore {
  return {
    async refused(provider, at) {
      const value = JSON.stringify({ provider, reason: 'credit', since: at.toISOString() })
      await db()
        .insert(setting)
        .values({ key: ASSIST_PROVIDER_KEY, value, updatedAt: at })
        .onConflictDoUpdate({ target: setting.key, set: { updatedAt: at } })
    },
    async accepted(provider, startedAt) {
      const ended = await db()
        .delete(setting)
        .where(and(eq(setting.key, ASSIST_PROVIDER_KEY), lt(setting.updatedAt, startedAt)))
        .returning({ value: setting.value })
      if (ended.length > 0) {
        console.log(JSON.stringify({ event: 'assist_provider_accepted', provider }))
      }
    },
  }
}

/** What the health page says of a stored refusal; anything unreadable is nothing. */
export function parseRefusal(
  value: string | undefined,
  lastAt: Date | undefined,
): AssistProviderRefusal | null {
  if (!value) return null
  try {
    const stored = JSON.parse(value) as Partial<Stored>
    if (typeof stored.provider !== 'string' || stored.reason !== 'credit') return null
    if (typeof stored.since !== 'string') return null
    return {
      provider: stored.provider,
      reason: 'credit',
      since: stored.since,
      lastAt: (lastAt ?? new Date(stored.since)).toISOString(),
    }
  } catch {
    return null
  }
}

/** The refusal in force, for the health page. */
export async function readRefusal(db: Database): Promise<AssistProviderRefusal | null> {
  const [row] = await db.select().from(setting).where(eq(setting.key, ASSIST_PROVIDER_KEY))
  return parseRefusal(row?.value, row?.updatedAt ?? undefined)
}

/**
 * The provider plugins of an assistant: every builtin, with the watched one's fetch wrapped. The plugin's profile
 * replaces the builtin of the same name for the run, so every assistant hands over the same one.
 */
export function watchedProviders(
  plugins: Plugin[],
  store: RefusalStore = settingStore(),
): Plugin[] {
  return plugins.map((plugin) => {
    if (plugin.kind !== 'model-provider' || plugin.profile.name !== WATCHED) return plugin
    const own = plugin.profile.transform
    return {
      ...plugin,
      profile: {
        ...plugin.profile,
        transform: {
          ...own,
          fetch: (ctx) => watchedFetch(WATCHED, store, own?.fetch?.(ctx)),
        },
      },
    }
  })
}

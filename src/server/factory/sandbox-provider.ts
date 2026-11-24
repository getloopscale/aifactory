import { SANDBOX_PROVIDERS, type SandboxProviderName } from '../../shared/panel'

import { dockerSandboxProvider } from './docker-sandbox'
import { e2bSandboxProvider } from './e2b-sandbox'
import type { IsolatedSandboxProvider } from './sandbox'
import { withLease } from './sandbox-lease'
import { vercelSandboxProvider } from './vercel-sandbox'

/**
 * Where sandboxes run: Vercel Sandbox by default, or containers on this machine with
 * `FACTORY_SANDBOX=docker` (for when the Vercel plan has no capacity left, or to keep a run off the cloud), or
 * E2B with `FACTORY_SANDBOX=e2b` (`E2B_API_KEY`).
 * Any other value is refused rather than ignored: running somewhere the owner did not choose is the
 * mistake that costs money or leaks work.
 */
export function sandboxChoice(env: NodeJS.ProcessEnv = process.env): SandboxProviderName {
  const choice = env.FACTORY_SANDBOX?.trim() || 'vercel'
  if (!(SANDBOX_PROVIDERS as readonly string[]).includes(choice)) {
    throw new Error(`FACTORY_SANDBOX is "${choice}": use vercel, docker or e2b`)
  }
  return choice as SandboxProviderName
}

export function sandboxProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): IsolatedSandboxProvider {
  const choice = sandboxChoice(env)
  if (choice === 'vercel') return vercelSandboxProvider()
  if (choice === 'docker') return dockerSandboxProvider({ env })
  return withLease(e2bSandboxProvider(env))
}

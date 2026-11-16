import { defineCron } from 'theokit/server/cron'

import { getDb } from '../db'
import { factoryDeps } from '../factory/deps'
import { supervise } from '../factory/supervise'
import { reapSandboxes } from '../factory/sandbox-reaper'
import { mainProcessOnly } from '../factory/worker-only'

/**
 * Checks the factory itself every five minutes: work that stopped moving, and things waiting for
 * something that is gone. It reports and never acts; a person resolves a finding from the panel.
 */
export default defineCron('supervise', {
  schedule: '*/5 * * * *',
  // A worker-only process leaves the crons to the main one (see worker-only.ts).
  handler: mainProcessOnly(async () => {
    let deps
    try {
      deps = factoryDeps()
    } catch (error) {
      console.error(JSON.stringify({ event: 'supervise_not_configured', error: String(error) }))
      return
    }
    const provider = deps.sandbox
    const result = await supervise({
      db: getDb(),
      // A provider that cannot be asked leaves the snapshot check out, and nothing gets resolved by that.
      listSnapshots: provider.listSnapshots?.bind(provider),
    })
    // Sandboxes whose owner is done hold the account's slots and bill: stop them. Failing here leaves the rest.
    if (provider.listSandboxes && provider.killSandbox) {
      try {
        await reapSandboxes({
          db: getDb(),
          listSandboxes: provider.listSandboxes.bind(provider),
          killSandbox: provider.killSandbox.bind(provider),
        })
      } catch (error) {
        console.error(JSON.stringify({ event: 'sandbox_reap_failed', error: String(error) }))
      }
    }
    if (result.opened.length > 0 || result.resolved.length > 0) {
      console.log(JSON.stringify({ event: 'supervise', ...result }))
    }
  }),
})

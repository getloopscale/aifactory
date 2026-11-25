import { defineConfig } from 'vitest/config'

// The conversation spike lives outside `src/` and outside the root config's projects, so neither `pnpm test`
// nor `pnpm evals:check` reaches it. Run it by name:
//   SPIKE_CLI=claude|codex node --env-file=.env.local node_modules/vitest/vitest.mjs run --config spikes/e2b/vitest.config.ts
export default defineConfig({
  test: {
    include: ['spikes/e2b/**/*.test.ts'],
    testTimeout: 1_800_000,
    hookTimeout: 60_000,
  },
})

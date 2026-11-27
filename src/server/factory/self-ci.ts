import { isFactoryRepository } from '../evals/cases'

/**
 * The status check that runs the factory's integration tests: the `check` job of the `CI` workflow, which
 * has a Postgres service. A sandbox has no Postgres, so the saved checks never run them. Only that job's
 * context counts: a status named `CI` could come from anywhere.
 */
export const SELF_CI_CHECK = 'check'

/**
 * Why the factory may not integrate a pull request of `repository` now, or undefined when it may. The
 * factory's own repository integrates only through a branch that requires its CI, so a change whose
 * integration tests fail is never merged; any other repository is unaffected.
 */
export function selfCiRefusal(repository: string, required: string[]): string | undefined {
  if (!isFactoryRepository(repository)) return undefined
  if (required.includes(SELF_CI_CHECK)) return undefined
  return (
    `the integration branch of ${repository} does not require the \`${SELF_CI_CHECK}\` check of the CI workflow, ` +
    'so its integration tests would run only after the merge. Require it in the branch protection or a ' +
    'ruleset and allow auto-merge.'
  )
}

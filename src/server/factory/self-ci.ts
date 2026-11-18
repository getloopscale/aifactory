import { FACTORY_REPOSITORY } from '../evals/cases'

/**
 * The status checks that run the factory's integration tests: the `check` job of the `CI` workflow, which
 * has a Postgres service. A sandbox has no Postgres, so the saved checks never run them.
 */
export const SELF_CI_CHECKS = ['check', 'CI']

/**
 * Why the factory may not integrate a pull request of `repository` now, or undefined when it may. The
 * factory's own repository integrates only through a branch that requires its CI, so a change whose
 * integration tests fail is never merged; any other repository is unaffected. `own` is for a fork.
 */
export function selfCiRefusal(
  repository: string,
  required: string[],
  own: string = FACTORY_REPOSITORY,
): string | undefined {
  if (repository !== own) return undefined
  if (required.some((name) => SELF_CI_CHECKS.includes(name))) return undefined
  return (
    `the integration branch of ${repository} does not require the CI check (${SELF_CI_CHECKS.join(' or ')}), ` +
    'so its integration tests would run only after the merge. Require it in the branch protection or a ' +
    'ruleset and allow auto-merge.'
  )
}

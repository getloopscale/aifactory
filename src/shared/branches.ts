/**
 * The branch every repository the factory works in integrates into (`workspace`), and the rule that picks
 * it. Both halves read it: the server targets its pull requests there, and the Code Mode start form offers
 * it as the branch a session starts from, so the two never disagree.
 */
export const INTEGRATION_BRANCH = 'workspace'

/** The branch work starts from and pull requests target: the owner's choice, or `workspace`. */
export const integrationBranch = (config: { baseBranch?: string | null }): string =>
  config.baseBranch ?? INTEGRATION_BRANCH

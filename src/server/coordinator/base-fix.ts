import type { RedBase } from './exceptions'

/**
 * The issue the coordinator files when an integration branch stays red while it holds tasks (`fix_base` in
 * `decide.ts`). Pure: `apply.ts` files it, once per signature, through `fileOnce`.
 */

/** What makes two red bases the same one: the repository, its integration branch and the set of checks. */
export const baseSignature = ({ repository, branch, checks }: RedBase): string =>
  `base_red:${repository}:${branch}:${[...checks].sort().join(',')}`

const named = (checks: string[]) => {
  const quoted = checks.map((name) => `"${name}"`)
  return quoted.length === 1 ? quoted[0] : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`
}

/** How to see the failure: the commands the factory runs, or the checks as CI runs them. */
function reproduce({ checks, commands }: RedBase): string {
  if (commands.length === 0) return `Run the failing checks as CI runs them: ${checks.join(', ')}.`
  return commands.map((c) => `Run \`${c.command}\` (${c.name}).`).join(' ')
}

/** The title and body of the issue, which follows `previous` when an earlier issue for it was closed. */
export function baseFixIssue(base: RedBase, previous?: number): { title: string; body: string } {
  const { repository, branch, sha, checks } = base
  const again =
    previous === undefined
      ? []
      : [`The last issue for these checks, #${previous}, was closed, and they fail again.`, '']
  const body = [
    `The required checks ${named(checks)} fail on \`${branch}\` at \`${sha}\`. The factory's tasks on ${repository} wait for them to pass there before they integrate, so this goes first.`,
    '',
    ...again,
    '## Failing checks',
    '',
    ...checks.map((name) => `- \`${name}\``),
    '',
    `Their runs on the commit: https://github.com/${repository}/commit/${sha}/checks`,
    '',
    '## Reproduce',
    '',
    `1. Check out \`${branch}\` at \`${sha}\`.`,
    `2. ${reproduce(base)}`,
    '',
    '## Done when',
    '',
    `${named(checks)} pass on \`${branch}\`.`,
    '',
    'Filed by the coordinator of the factory, for an integration branch red for hours (`base_red`).',
  ].join('\n')
  return { title: `Fix ${named(checks)} failing on ${branch}`, body }
}

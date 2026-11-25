/**
 * The one way to name a task's item in text or a tag: `#4` for a GitHub issue, `ENG-12` for a Linear one. A
 * Linear task's `issueNumber` is a negative local ordinal and never reaches a person.
 */
export const itemRef = (row: {
  issueNumber: number
  source?: string
  displayIdentifier?: string | null
}): string =>
  row.source === 'linear' || row.issueNumber < 0
    ? (row.displayIdentifier ?? 'a Linear item')
    : `#${row.issueNumber}`

/** `#n` for a GitHub issue number; a negative local ordinal is a Linear item and is never shown as a number. */
export const issueRef = (issueNumber: number): string =>
  issueNumber < 0 ? 'a Linear item' : `#${issueNumber}`

/** `owner/name#4`, or `owner/name (a Linear item)` for a negative local ordinal. */
export const repoItemRef = (repository: string, issueNumber: number): string =>
  issueNumber < 0 ? `${repository} (a Linear item)` : `${repository}#${issueNumber}`

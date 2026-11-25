/** How the repository form writes checks and domains as text, and reads them back. */

export type Check = { name: string; command: string; artifacts?: string[] }

/** A line may end with ` @artifacts dir/ file.png`: the paths the check writes files to, copied out after it runs. */
const ARTIFACTS = /\s+@artifacts\s+(.+)$/

/** One check per line, `name: command`. A line with no colon is a command named after its first word. */
export function parseChecks(text: string): Check[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((full) => {
      const match = ARTIFACTS.exec(full)
      const line = match ? full.slice(0, match.index).trim() : full
      const artifacts = match ? match[1].trim().split(/\s+/) : []
      const check = parseLine(line)
      return artifacts.length > 0 ? { ...check, artifacts } : check
    })
}

function parseLine(line: string): Check {
  const colon = line.indexOf(':')
  if (colon > 0 && /^[a-z0-9][a-z0-9_-]*$/.test(line.slice(0, colon).trim())) {
    return { name: line.slice(0, colon).trim(), command: line.slice(colon + 1).trim() }
  }
  const word =
    line
      .split(/\s+/)[0]
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '') || 'check'
  return { name: word, command: line }
}

export const formatChecks = (checks: Check[] | null) =>
  (checks ?? [])
    .map(
      (c) =>
        `${c.name}: ${c.command}${c.artifacts?.length ? ` @artifacts ${c.artifacts.join(' ')}` : ''}`,
    )
    .join('\n')

/** Domains separated by commas, spaces or lines. */
export const parseDomains = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d !== '')

export const formatDomains = (domains: string[]) => domains.join('\n')

/** One fix command per line, trimmed; blank lines are dropped. */
export const parseFixes = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')

export const formatFixes = (fixes: string[]) => fixes.join('\n')

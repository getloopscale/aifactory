/** One line of a file's change as the panel draws it. A `meta` line is a hunk header or a marker of git's. */
export type DiffLine =
  | { kind: 'meta'; text: string }
  | { kind: 'context'; text: string; oldLine: number; newLine: number }
  | { kind: 'add'; text: string; newLine: number }
  | { kind: 'del'; text: string; oldLine: number }

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/**
 * Reads a unified patch into lines with the number each has on its side. A line before the first hunk
 * header has no number to take, so it is kept as `meta` rather than counted from a guess.
 */
export function parsePatch(patch: string): DiffLine[] {
  const lines: DiffLine[] = []
  let oldLine: number | undefined
  let newLine: number | undefined
  for (const raw of patch.split('\n')) {
    const hunk = HUNK.exec(raw)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      lines.push({ kind: 'meta', text: raw })
      continue
    }
    if (oldLine === undefined || newLine === undefined || raw.startsWith('\\')) {
      if (raw !== '') lines.push({ kind: 'meta', text: raw })
      continue
    }
    const text = raw.slice(1)
    if (raw.startsWith('+')) {
      lines.push({ kind: 'add', text, newLine })
      newLine += 1
    } else if (raw.startsWith('-')) {
      lines.push({ kind: 'del', text, oldLine })
      oldLine += 1
    } else {
      lines.push({ kind: 'context', text, oldLine, newLine })
      oldLine += 1
      newLine += 1
    }
  }
  return lines
}

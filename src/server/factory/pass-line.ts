/**
 * The log line of a cron pass: the event with what the pass found, or nothing when no list in it moved. A
 * count such as `waiting` is said in the line but never makes one on its own, so a quiet pass logs nothing.
 */
export function passLine(event: string, result: Record<string, unknown>): string | undefined {
  const moved = Object.values(result).some((value) => Array.isArray(value) && value.length > 0)
  return moved ? JSON.stringify({ event, ...result }) : undefined
}

import { LANES, type FloorState, type Lane } from '../../lib/floor'

/** The colour of each state, as a fill. */
export const DOT: Record<FloorState, string> = {
  moving: 'bg-primary',
  owner: 'bg-warning',
  factory: 'bg-info',
  queued: 'bg-muted-foreground/60',
  delivered: 'bg-success',
}

/**
 * Where a task is on the line, as seven segments: the stations behind it are filled, the one it is at is
 * filled and beats while the factory moves it, and the colour says who moves it next. A task that left the
 * line shows every segment faint in that colour.
 */
export function StageTape({
  lane,
  state,
  label,
}: {
  lane: Lane | null
  state: FloorState
  label: string
}) {
  const at = lane === null ? -1 : LANES.indexOf(lane)
  return (
    <div role="img" aria-label={label} className="grid grid-cols-7 gap-[3px]">
      {LANES.map((each, index) => (
        <span
          key={each}
          className={`h-1.5 rounded-sm ${
            at === -1
              ? `${DOT[state]} opacity-30`
              : index < at
                ? DOT[state]
                : index === at
                  ? `${DOT[state]} ${state === 'moving' ? 'motion-safe:animate-pulse' : ''}`
                  : 'bg-muted'
          }`}
        />
      ))}
    </div>
  )
}

/** The dot and the word for who moves a task next. */
export function StatePill({ state, label }: { state: FloorState; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] text-foreground/80">
      <span aria-hidden className={`size-1.5 rounded-full ${DOT[state]}`} />
      {label}
    </span>
  )
}

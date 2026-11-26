/**
 * The LoopScale symbol: two half circles around a point, each turn wider than the last. The loop takes the
 * colour of the text around it and the point is the one place the brand colour always shows.
 */
export function BrandMark({ className = 'size-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={`shrink-0 ${className}`}>
      <circle cx="12" cy="18" r="2.6" className="fill-primary" />
      <path
        d="M20,18 A8,8 0 0 1 4,18 A12,12 0 0 1 28,18"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
      />
    </svg>
  )
}

import type { CiState, PullRequestCi } from '../../shared/panel'
import { useCopy } from '../lib/copy'
import { TONE_DOT, type Tone } from './ui/Surface'

export const CI_TONE: Record<CiState, Tone> = {
  running: 'warning',
  passed: 'success',
  failed: 'destructive',
}

/** What the card says of the pull request's GitHub checks: a coloured dot, and words that carry no colour. */
export function CiSummary({ ci }: { ci: PullRequestCi }) {
  const { t } = useCopy()
  const [first, ...rest] = ci.failed
  const words =
    ci.state === 'running'
      ? t.board.ci.running(ci.done, ci.total)
      : ci.state === 'failed'
        ? t.board.ci.failed(first ?? '', rest.length)
        : t.board.ci.passed
  return (
    <span data-ci={ci.state}>
      <span
        aria-hidden
        className={`mr-1 inline-block size-1.5 rounded-full align-middle ${TONE_DOT[CI_TONE[ci.state]]}`}
      />
      {words}
    </span>
  )
}

import { itemName } from '../../lib/format'

type Item = { issueNumber: number; displayIdentifier?: string | null; repository?: string }

/** The look of an item's number wherever it is written: the one thing on a line that is never cut short. */
const LOOK =
  'shrink-0 rounded bg-muted px-1.5 py-px font-mono font-semibold tabular-nums text-foreground'

const SIZE = { small: 'text-[11px]', large: 'text-sm' }

/**
 * The number the owner knows a task by (`#637`, or `ENG-12` for an item of another tracker). It leads the line
 * it is on and does not shrink, so the repository or the title is what gets cut when there is no room. With
 * `link`, a GitHub issue's number opens the issue; inside a card that is already a link it is plain text.
 */
export function ItemId({
  item,
  size = 'small',
  link = false,
  title,
}: {
  item: Item
  size?: keyof typeof SIZE
  link?: boolean
  title?: string
}) {
  const name = itemName(item)
  const look = `${LOOK} ${SIZE[size]}`
  if (link && item.repository && !item.displayIdentifier) {
    return (
      <a
        data-item-id=""
        href={`https://github.com/${item.repository}/issues/${item.issueNumber}`}
        target="_blank"
        rel="noreferrer"
        title={title}
        className={`${look} hover:underline focus-visible:outline-2 focus-visible:outline-ring`}
      >
        {name}
      </a>
    )
  }
  return (
    <span data-item-id="" title={title} className={look}>
      {name}
    </span>
  )
}

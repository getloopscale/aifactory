import type { GuideId } from '../../../shared/guides'
import type { Copy } from '../../lib/copy/en'
import { guideIdFor } from '../../lib/guides'

/** The group of the menu each place of the factory is listed under. */
export const GROUP_OF: Record<GuideId, 'operation' | 'factory'> = {
  board: 'operation',
  inbox: 'operation',
  plans: 'operation',
  repositories: 'factory',
  agents: 'factory',
  health: 'factory',
  setup: 'factory',
}

const FLOOR_VIEWS = ['attention', 'decisions', 'projects'] as const

/** The path from the menu to the page the owner is on, as the names the menu uses. */
export function crumbs(pathname: string, t: Copy): string[] {
  if (pathname === '/' || pathname.startsWith('/chat/')) return [t.topBar.chat]
  if (pathname.startsWith('/floor')) {
    const view = FLOOR_VIEWS.find((name) => pathname.startsWith(`/floor/${name}`))
    return [t.menu.groups.operation, t.floor.name, t.floor.views[view ?? 'line']]
  }
  if (pathname.startsWith('/onboarding')) return [t.onboarding.title]
  const place = guideIdFor(pathname)
  if (!place) return []
  const item = /^\/(?:tasks|plans)\/(\d+)$/.exec(pathname)
  return [t.menu.groups[GROUP_OF[place]], t.places[place], ...(item ? [`#${item[1]}`] : [])]
}

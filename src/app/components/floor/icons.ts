import {
  ArrowUpToLine,
  CircleHelp,
  Eye,
  FileText,
  FlaskConical,
  GitBranch,
  GitMerge,
  Hammer,
  Hourglass,
  Inbox,
  ListTree,
  type LucideIcon,
  PackageCheck,
  Rocket,
  RotateCw,
  ScanSearch,
  ShieldCheck,
  Siren,
  Undo2,
  UserRound,
  Wrench,
} from 'lucide-react'

import type { AgentRole, AgentStep, InboxItem } from '../../../shared/panel'
import type { Lane } from '../../lib/floor'

/** The picture of each station of the line. */
export const LANE_ICON: Record<Lane, LucideIcon> = {
  queue: Inbox,
  build: Hammer,
  checks: FlaskConical,
  review: Eye,
  merge: GitMerge,
  integrated: GitBranch,
  released: Rocket,
}

/** The picture of what an agent, or the factory, does on a running task. */
export const STEP_ICON: Record<AgentStep['step'], LucideIcon> = {
  planning: ListTree,
  building: Hammer,
  fixing: Wrench,
  reviewing: Eye,
  securing: ShieldCheck,
  checks: FlaskConical,
}

export const ROLE_ICON: Record<AgentRole, LucideIcon> = {
  planner: ListTree,
  builder: Hammer,
  reviewer: Eye,
  security: ShieldCheck,
  merger: GitMerge,
  lens: ScanSearch,
}

export const INBOX_ICON: Record<InboxItem['kind'], LucideIcon> = {
  question: CircleHelp,
  review: Eye,
  handoff: UserRound,
  failed: Siren,
  main_red: Siren,
}

/** The picture of a decision of the coordinator; one it has no picture for shows the fallback. */
const ACTION_ICON: Record<string, LucideIcon> = {
  send_back: Undo2,
  review_again: Eye,
  retry_from_finding: RotateCw,
  scope: FileText,
  release: PackageCheck,
  prioritise: ArrowUpToLine,
  fix_base: Wrench,
  merge_base: GitMerge,
  wait: Hourglass,
  escalate: UserRound,
}
export const actionIcon = (action: string): LucideIcon => ACTION_ICON[action] ?? CircleHelp

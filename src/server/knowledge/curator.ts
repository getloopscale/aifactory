import type { Database } from '../db'
import type { OneShot } from '../factory/assistant'
import { modeFromEnv, type CoordinatorMode } from '../coordinator/mode'

import { aliasOf, groupKey, parseAnswer } from './curator-answer'
import { curatedNote, notesFolder, type CuratedNote } from './format'
import { Mirror, mirrorDir } from './mirror'
import { isReserved } from './okf'
import {
  curatedAt,
  markCurated,
  loadKnowledgeConfig,
  loadSyncState,
  recordCurations,
  type CurationMode,
  type NewCuration,
} from './store'

/** The mode of the curator (`FACTORY_KNOWLEDGE_CURATOR_MODE`): `trial` unless the owner sets another. */
export const curatorModeFromEnv = (env: NodeJS.ProcessEnv): CoordinatorMode =>
  modeFromEnv(env, 'FACTORY_KNOWLEDGE_CURATOR_MODE')

/** The most notes of a project one answer is asked about, and the most characters of each it reads. */
const NOTES_PER_PROJECT = 50
const NOTE_CHARS = 600

export type CuratorDeps = {
  db: Database
  /** Where the mirrors are kept. */
  root: string
  assistant: OneShot
  now?: () => Date
}

export type CuratorResult = { projects: number; decisions: number; errors: number }

/** The current notes of one project at a commit, newest first, as far as one answer reads. */
async function notesAt(mirror: Mirror, sha: string, project: string, now: Date) {
  const notes: CuratedNote[] = []
  for (const file of await mirror.list(sha, [notesFolder(project)])) {
    if (isReserved(file.path)) continue
    const text = await mirror.read(sha, file.path)
    const note = text ? curatedNote(file.path, text.toString('utf8')) : undefined
    if (note && Date.parse(note.staleAfter) > now.getTime()) notes.push(note)
  }
  notes.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt) || b.path.localeCompare(a.path))
  return notes.slice(0, NOTES_PER_PROJECT)
}

/** What the assistant is asked: the notes by alias, each with the task it came from. */
export function curatorMessage(project: string, notes: CuratedNote[]): string {
  const listed = notes.map(
    (n, i) =>
      `<note id="${aliasOf(i)}" tasks="${n.taskIds.join(',')}">\n${n.body.slice(0, NOTE_CHARS)}\n</note>`,
  )
  return `Notes about ${project}:\n\n${listed.join('\n\n')}`
}

/**
 * One pass of the curator: for each project with notes on the memory branch, asks the assistant to group them
 * and records what it answered, once per commit of the branch. In `auto` a merge or a promotion is recorded
 * `pending`, and only `knowledge-sync` writes it; in `trial` nothing is ever written. An answer that does not
 * parse, or names something the notes do not hold, is recorded as an error and changes nothing.
 */
export async function curate(deps: CuratorDeps, mode: CurationMode): Promise<CuratorResult> {
  const result: CuratorResult = { projects: 0, decisions: 0, errors: 0 }
  const config = await loadKnowledgeConfig(deps.db)
  const state = await loadSyncState(deps.db)
  const memorySha = state?.repository === config?.repository ? state?.memorySha : undefined
  if (!config || !memorySha) return result
  const now = (deps.now ?? (() => new Date()))()
  const mirror = new Mirror(mirrorDir(deps.root, config.repository))
  const projects = new Set<string>()
  for (const file of await mirror.list(memorySha, ['memory/projects/'])) {
    const match = /^memory\/projects\/([^/]+\/[^/]+)\//.exec(file.path)
    if (match) projects.add(match[1])
  }
  for (const project of [...projects].sort()) {
    const notes = await notesAt(mirror, memorySha, project, now)
    const at = { knowledgeRepository: config.repository, repository: project, mode, memorySha }
    if (notes.length < 2 || (await curatedAt(deps.db, at))) continue
    result.projects += 1
    const rows = await decide(deps, project, notes, { ...at, status: 'recorded' })
    result.errors += rows.filter((r) => r.action === 'error').length
    result.decisions += await recordCurations(deps.db, withStatus(rows, mode))
    await markCurated(deps.db, at)
  }
  return result
}

/** In `auto` what a write waits on is `pending`; `keep` and errors, and everything in `trial`, only record. */
const withStatus = (rows: NewCuration[], mode: CurationMode): NewCuration[] =>
  rows.map((r) =>
    mode === 'auto' && (r.action === 'merge' || r.action === 'promote')
      ? { ...r, status: 'pending' }
      : r,
  )

async function decide(
  deps: CuratorDeps,
  project: string,
  notes: CuratedNote[],
  base: Omit<NewCuration, 'action' | 'groupKey' | 'detail'>,
): Promise<NewCuration[]> {
  let response: string
  try {
    response = (await deps.assistant(curatorMessage(project, notes))).response
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return [
      {
        ...base,
        action: 'error',
        groupKey: groupKey('error', [base.memorySha]),
        detail: { error: reason.slice(0, 500) },
      },
    ]
  }
  const answer = parseAnswer(response, notes)
  if ('error' in answer) {
    return [
      {
        ...base,
        action: 'error',
        groupKey: groupKey('error', [base.memorySha, response]),
        detail: { error: answer.error, answer: response.slice(0, 500) },
      },
    ]
  }
  return answer.groups.map((g) => ({
    ...base,
    action: g.action,
    groupKey: groupKey(
      g.action,
      g.notes.map((n) => n.path),
    ),
    detail: {
      paths: g.notes.map((n) => n.path),
      title: g.title,
      text: g.text,
      tasks: [...new Set(g.notes.flatMap((n) => n.taskIds))],
    },
  }))
}

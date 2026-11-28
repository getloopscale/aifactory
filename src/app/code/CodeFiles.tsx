import { ChevronDown, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { CodeFileResponse } from '../../shared/code'
import { Quiet } from '../components/ui/Surface'
import { ApiError, get } from '../lib/api'
import { useCopy, type CopyState } from '../lib/copy'

/** The files whose path holds `filter`, ignoring case. An empty filter keeps all. */
export function filterFiles(files: string[], filter: string): string[] {
  const needle = filter.trim().toLowerCase()
  return needle === '' ? files : files.filter((f) => f.toLowerCase().includes(needle))
}

type Node = { name: string; path: string; dirs: Map<string, Node>; files: string[] }

function treeOf(files: string[]): Node {
  const root: Node = { name: '', path: '', dirs: new Map(), files: [] }
  for (const file of files) {
    const parts = file.split('/')
    let at = root
    for (const part of parts.slice(0, -1)) {
      const path = at.path ? `${at.path}/${part}` : part
      if (!at.dirs.has(part)) at.dirs.set(part, { name: part, path, dirs: new Map(), files: [] })
      at = at.dirs.get(part)!
    }
    at.files.push(file)
  }
  return root
}

function Branch({
  node,
  depth,
  open,
  toggle,
  selected,
  onSelect,
}: {
  node: Node
  depth: number
  open: (path: string) => boolean
  toggle: (path: string) => void
  selected: string | undefined
  onSelect: (path: string) => void
}) {
  const pad = { paddingLeft: `${0.5 + depth * 0.9}rem` }
  return (
    <>
      {[...node.dirs.values()].map((dir) => {
        const isOpen = open(dir.path)
        const Chevron = isOpen ? ChevronDown : ChevronRight
        return (
          <li key={dir.path} role="none">
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => toggle(dir.path)}
              style={pad}
              className="flex w-full items-center gap-1 py-1 pr-2 text-left font-mono text-xs hover:bg-muted/60"
            >
              <Chevron aria-hidden className="size-3 shrink-0 text-muted-foreground" />
              {dir.name}
            </button>
            {isOpen ? (
              <ul role="group">
                <Branch
                  node={dir}
                  depth={depth + 1}
                  open={open}
                  toggle={toggle}
                  selected={selected}
                  onSelect={onSelect}
                />
              </ul>
            ) : null}
          </li>
        )
      })}
      {node.files.map((file) => (
        <li key={file} role="none">
          <button
            type="button"
            aria-current={file === selected ? 'true' : undefined}
            onClick={() => onSelect(file)}
            style={{ paddingLeft: `${1.4 + depth * 0.9}rem` }}
            className={`block w-full break-all py-1 pr-2 text-left font-mono text-xs hover:bg-muted/60 ${
              file === selected ? 'bg-muted font-semibold' : ''
            }`}
          >
            {file.slice(file.lastIndexOf('/') + 1)}
          </button>
        </li>
      ))}
    </>
  )
}

/** The text of one file, read-only, with the number of each line. */
/** Why a read of the workspace failed, in the page's language when the API named a reason the page knows. */
export function readError(e: unknown, t: CopyState['t']): string {
  if (e instanceof ApiError && e.code === 'workspace_unavailable') return t.code.files.unavailable
  return e instanceof Error ? e.message : String(e)
}

export function FileViewer({
  sessionId,
  path,
  fill = false,
}: {
  sessionId: string
  path: string
  /** In an editor pane: no heading of its own, and as tall as the pane. */
  fill?: boolean
}) {
  const { t } = useCopy()
  const f = t.code.files
  const [state, setState] = useState<{
    path: string
    file?: CodeFileResponse
    error?: unknown
  }>({ path })
  useEffect(() => {
    let alive = true
    get<CodeFileResponse>(
      `/api/panel/code/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(path)}`,
    ).then(
      (file) => alive && setState({ path, file }),
      (error: unknown) => alive && setState({ path, error }),
    )
    return () => {
      alive = false
    }
  }, [sessionId, path])
  const current = state.path === path ? state : { path }
  const lines = useMemo(() => {
    if (!current.file) return []
    const all = current.file.content.split('\n')
    if (all.length > 1 && all[all.length - 1] === '') all.pop()
    return all
  }, [current.file])
  return (
    <div
      role="region"
      aria-label={f.viewerOf(path)}
      className={fill ? 'flex h-full min-h-0 flex-col' : 'border-t border-border'}
    >
      {fill ? null : (
        <p className="break-all px-3 py-1.5 font-mono text-xs text-muted-foreground">{path}</p>
      )}
      {current.error !== undefined ? (
        <p role="alert" className="px-3 py-2 text-sm text-destructive">
          {readError(current.error, t)}
        </p>
      ) : !current.file ? (
        <Quiet role="status">{f.loading}</Quiet>
      ) : (
        <>
          {current.file.truncated ? (
            <p role="status" className="px-3 py-1.5 text-xs text-muted-foreground">
              {f.truncated(current.file.limit)}
            </p>
          ) : null}
          <div
            className={`overflow-auto bg-background font-mono text-xs leading-5 [scrollbar-width:thin] ${fill ? 'min-h-0 flex-1 py-1' : 'max-h-96'}`}
          >
            {lines.map((line, i) => (
              <div key={i} data-line={i + 1} className="grid grid-cols-[3rem_minmax(0,1fr)]">
                <span className="select-none pr-2 text-right tabular-nums text-muted-foreground">
                  {i + 1}
                </span>
                <span className="min-w-0 whitespace-pre-wrap break-all pr-3">{line}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** The tree of the workspace's files with a filter box, and the viewer of the one that is open. */
export function CodeFiles({
  sessionId,
  files,
  error,
  selected,
  onSelect,
  bare = false,
}: {
  sessionId: string
  files: string[] | undefined
  error: string | undefined
  selected: string | undefined
  onSelect: (path: string) => void
  /** Only the tree, as tall as it needs: the file opens somewhere else. */
  bare?: boolean
}) {
  const { t } = useCopy()
  const f = t.code.files
  const [filter, setFilter] = useState('')
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const shown = useMemo(() => filterFiles(files ?? [], filter), [files, filter])
  const tree = useMemo(() => treeOf(shown), [shown])
  const filtering = filter.trim() !== ''
  const toggle = (path: string) =>
    setClosed((c) => {
      const next = new Set(c)
      if (!next.delete(path)) next.add(path)
      return next
    })
  return (
    <div>
      <div className="px-3 py-2">
        <input
          type="search"
          aria-label={f.filter}
          placeholder={f.filter}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="h-8 w-full rounded-lg border border-border bg-card px-2 text-sm text-foreground"
        />
      </div>
      {error ? (
        <p role="alert" className="px-4 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {files === undefined ? (
        error ? null : (
          <Quiet role="status">{f.loading}</Quiet>
        )
      ) : shown.length === 0 ? (
        <Quiet>{filtering ? f.noMatch : f.empty}</Quiet>
      ) : (
        <ul
          role="tree"
          aria-label={f.tree}
          className={bare ? 'pb-2' : 'max-h-64 overflow-y-auto pb-2'}
        >
          <Branch
            node={tree}
            depth={0}
            open={(path) => filtering || !closed.has(path)}
            toggle={toggle}
            selected={selected}
            onSelect={onSelect}
          />
        </ul>
      )}
      {selected && !bare ? <FileViewer sessionId={sessionId} path={selected} /> : null}
    </div>
  )
}

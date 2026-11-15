import { useState } from 'react'
import { Link } from 'react-router'

import { Button } from '@usetheo/ui'

import type { InboxItem } from '../../shared/panel'
import { StageBadge } from '../components/Badges'
import { post } from '../lib/api'
import { ago, money } from '../lib/format'
import { useResource } from '../lib/live'

const KIND: Record<InboxItem['kind'], string> = {
  question: 'Answer a question',
  review: 'Review the pull request',
  handoff: 'Needs a person',
  failed: 'Failed',
  main_red: 'The default branch is red',
  publication_partial: 'A package was not published',
}

export default function InboxPage() {
  const inbox = useResource<{ items: InboxItem[] }>('/api/panel/inbox')
  const [message, setMessage] = useState<string>()
  async function handled(id: number) {
    try {
      await post(`/api/panel/publications/${id}/handled`)
      inbox.reload()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <>
      <h1 className="mb-4 text-xl font-semibold">Inbox</h1>
      {message ? <p className="text-sm text-destructive">{message}</p> : null}
      {inbox.error ? <p className="text-sm text-destructive">{inbox.error}</p> : null}
      {inbox.data ? (
        inbox.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing waits for you.</p>
        ) : (
          <ul className="space-y-2">
            {inbox.data.items.map(({ task, kind, summary, at, publicationId }) => (
              <li key={`${kind}-${task.id}-${publicationId ?? ''}`}>
                <Link
                  to={`/tasks/${task.id}`}
                  className="block rounded-lg border border-border bg-card p-4 shadow-sm hover:border-primary/60"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-semibold">{KIND[kind]}</span>
                    <span className="text-xs text-muted-foreground">{ago(at)}</span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {task.repository} #{task.issueNumber} · {task.title}
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{summary}</p>
                  <div className="mt-2 flex items-center gap-3">
                    <StageBadge
                      stage={task.stage}
                      integrated={task.integrated}
                      waitingForChecks={task.waitingForChecks}
                      resolved={task.resolved}
                      retryable={task.retryable}
                    />
                    <span className="text-xs text-muted-foreground">{money(task.costUsd)}</span>
                  </div>
                </Link>
                {publicationId ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="mt-2"
                    onClick={() => void handled(publicationId)}
                  >
                    I handled it
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )
      ) : (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
    </>
  )
}

import { Button, Card, Input } from '@usetheo/ui'
import { useEffect, useState } from 'react'

import { put } from '../lib/api'
import { useCopy } from '../lib/copy'
import { useResource } from '../lib/live'

type Row = { team: string; repository: string }
type Settings = { labelId: string; teams: Record<string, string> }

/**
 * The Linear label and the mapping from a Linear team to a repository. They grant nothing alone: a Linear
 * item becomes a task only when its repository is enabled, as for a labelled GitHub issue.
 */
export function LinearCard() {
  const { t } = useCopy()
  const c = t.linear
  const resource = useResource<{ settings: Settings | null }>('/api/panel/linear', {
    stream: false,
    everyMs: 120_000,
  })
  const [label, setLabel] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [message, setMessage] = useState<string>()
  const saved = resource.data?.settings

  useEffect(() => {
    if (!saved) return
    setLabel(saved.labelId)
    setRows(Object.entries(saved.teams).map(([team, repository]) => ({ team, repository })))
  }, [saved])

  const change = (index: number, patch: Partial<Row>) =>
    setRows((all) => all.map((row, i) => (i === index ? { ...row, ...patch } : row)))

  async function save() {
    setMessage(undefined)
    try {
      const teams = Object.fromEntries(rows.map((r) => [r.team.trim(), r.repository.trim()]))
      await put('/api/panel/linear', { labelId: label.trim(), teams })
      setMessage(c.saved)
      resource.reload()
    } catch {
      setMessage(c.failed)
    }
  }

  return (
    <Card className="space-y-3 p-4">
      <h2 className="text-base font-semibold">{c.title}</h2>
      <p className="text-sm text-muted-foreground">{c.intro}</p>
      <Input
        aria-label={c.label}
        placeholder={c.label}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      {rows.map((row, index) => (
        <div key={index} className="flex flex-wrap gap-2">
          <Input
            aria-label={c.team}
            placeholder={c.team}
            value={row.team}
            onChange={(e) => change(index, { team: e.target.value })}
          />
          <Input
            aria-label={c.repository}
            placeholder={c.repository}
            value={row.repository}
            onChange={(e) => change(index, { repository: e.target.value })}
          />
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setRows((all) => all.filter((_, i) => i !== index))}
          >
            {c.remove}
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setRows((all) => [...all, { team: '', repository: '' }])}
        >
          {c.addTeam}
        </Button>
        <Button size="sm" onClick={save} disabled={label.trim() === ''}>
          {c.save}
        </Button>
      </div>
      {message ? (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      ) : null}
    </Card>
  )
}

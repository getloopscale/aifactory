import { Alert, Badge, Button } from '@usetheo/ui'
import { Link } from 'react-router'

import type { SetupItem, SetupReport } from '../../shared/panel'
import { ClaudeAccount } from '../components/ClaudeAccount'
import { CodexAccount } from '../components/CodexAccount'
import { KnowledgeRepository } from '../components/KnowledgeRepository'
import { PushNotifications } from '../components/PushNotifications'
import { NotifyButton } from '../components/NotifyButton'
import { PageHeader, Quiet, Row, Rows, STACK, Surface } from '../components/ui/Surface'
import { useCopy } from '../lib/copy'
import { useResource } from '../lib/live'

const TONE = { ok: 'success', warn: 'warning', missing: 'destructive' } as const

/** The block that changes the account or the repository a line of the checklist is about. */
function Fix({ id, onChanged }: { id: SetupItem['id']; onChanged: () => void }) {
  if (id === 'claude') return <ClaudeAccount onChanged={onChanged} />
  if (id === 'codex') return <CodexAccount onChanged={onChanged} />
  if (id === 'knowledge') return <KnowledgeRepository onChanged={onChanged} />
  return null
}

const FIXABLE: readonly string[] = ['claude', 'codex', 'knowledge']

function SetupRow({ item, onChanged }: { item: SetupItem; onChanged: () => void }) {
  const { t } = useCopy()
  const external = item.link?.href.startsWith('http')
  return (
    <Row
      lead={
        <Badge variant={TONE[item.status]} className="whitespace-nowrap">
          {t.setup.status[item.status]}
        </Badge>
      }
      title={item.label}
      detail={<span className="text-muted-foreground">{item.detail}</span>}
      trail={
        item.link && external && item.status === 'missing' ? (
          <Button asChild size="sm">
            <a href={item.link.href} target="_blank" rel="noreferrer">
              {item.link.label}
            </a>
          </Button>
        ) : item.link ? (
          external ? (
            <a
              href={item.link.href}
              target="_blank"
              rel="noreferrer"
              className="text-foreground underline underline-offset-2"
            >
              {item.link.label}
            </a>
          ) : (
            <Link to={item.link.href} className="text-foreground underline underline-offset-2">
              {item.link.label}
            </Link>
          )
        ) : undefined
      }
      below={FIXABLE.includes(item.id) ? <Fix id={item.id} onChanged={onChanged} /> : undefined}
    />
  )
}

/** What stands between a fresh install and a first pull request, with the page that fixes each part. */
export default function SetupPage() {
  const { t } = useCopy()
  const report = useResource<SetupReport>('/api/panel/setup', { everyMs: 30_000, stream: false })
  const data = report.data
  return (
    <>
      <PageHeader
        title={t.setup.title}
        actions={
          <>
            <NotifyButton />
            <Button size="sm" variant="secondary" onClick={report.reload}>
              {t.setup.checkAgain}
            </Button>
          </>
        }
      />
      <div className={STACK}>
        {report.error ? <p className="text-sm text-destructive">{report.error}</p> : null}
        {data ? (
          <>
            {data.ready ? (
              <Alert
                intent="success"
                title={t.setup.readyTitle}
                description={t.setup.readyDescription}
                action={
                  <Link to="/plans" className="text-sm underline underline-offset-2">
                    {t.setup.planTheWork}
                  </Link>
                }
              />
            ) : (
              <Alert
                intent="warning"
                title={t.setup.notReadyTitle}
                description={t.setup.notReadyDescription}
              />
            )}
            <Surface label={t.setup.title}>
              <Rows>
                {data.items.map((item) => (
                  <SetupRow key={item.id} item={item} onChanged={report.reload} />
                ))}
              </Rows>
            </Surface>
            <PushNotifications />
          </>
        ) : (
          <Surface label={t.setup.title}>
            <Quiet>{t.setup.loading}</Quiet>
          </Surface>
        )}
      </div>
    </>
  )
}

import { ListTree } from 'lucide-react'

import type { ChangePlanView } from '../../shared/panel'
import { useCopy } from '../lib/copy'
import { shortSha } from '../lib/format'

import { AgentIcon } from './floor/AgentIcon'
import { Quiet, READABLE, Surface } from './ui/Surface'

function Items({
  title,
  items,
  numbered = false,
}: {
  title: string
  items: string[]
  numbered?: boolean
}) {
  if (items.length === 0) return null
  const List = numbered ? 'ol' : 'ul'
  return (
    <div className="mt-2">
      <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
      <List
        className={`mt-1 space-y-1 pl-5 text-foreground ${numbered ? 'list-decimal' : 'list-disc'}`}
      >
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </List>
    </div>
  )
}

/**
 * What the builder said it would change before it changed anything. The latest plan is the one the
 * reviewer measured the diff by; a run that continued the task kept it.
 */
export function PlanSection({ plans }: { plans: ChangePlanView[] }) {
  const { t } = useCopy()
  const plan = plans.at(-1)
  return (
    <Surface title={t.planSection.title} icon={ListTree}>
      {plan === undefined ? (
        <Quiet>{t.planSection.none}</Quiet>
      ) : (
        <div className={`p-4 text-sm ${READABLE}`}>
          <p className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <AgentIcon agent={plan.harness} size="sm" />
            <span>
              {t.planSection.by(plan.harness, shortSha(plan.baseSha))}
              {plans.length > 1 ? t.planSection.latestOf(plans.length) : ''}
            </span>
          </p>
          <h3 className="mt-2 text-xs font-semibold text-muted-foreground">
            {t.planSection.files}
          </h3>
          {plan.files.length === 0 ? (
            <p className="mt-1 text-foreground">{t.planSection.noFile}</p>
          ) : (
            <ul className="mt-1 list-disc space-y-1 pl-5 text-foreground">
              {plan.files.map((f) => (
                <li key={f.path}>
                  <code>{f.path}</code>
                  {f.why ? `: ${f.why}` : null}
                </li>
              ))}
            </ul>
          )}
          <Items title={t.planSection.order} items={plan.order} numbered />
          <Items title={t.planSection.risks} items={plan.risks} />
          <Items title={t.planSection.proof} items={plan.proof} />
          <Items title={t.planSection.outOfScope} items={plan.outOfScope} />
        </div>
      )}
    </Surface>
  )
}

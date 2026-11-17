import type { ChangePlanView } from '../../shared/panel'
import { useCopy } from '../lib/copy'
import { shortSha } from '../lib/format'

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
    <section aria-label={t.planSection.title}>
      <h2 className="mb-2 text-sm font-semibold">{t.planSection.title}</h2>
      {plan === undefined ? (
        <p className="text-sm text-muted-foreground">{t.planSection.none}</p>
      ) : (
        <div className="rounded border border-border bg-card p-3 text-sm">
          <p className="text-xs text-muted-foreground">
            {t.planSection.by(plan.harness, shortSha(plan.baseSha))}
            {plans.length > 1 ? t.planSection.latestOf(plans.length) : ''}
          </p>
          <h3 className="mt-2 text-xs font-semibold text-muted-foreground">
            {t.planSection.files}
          </h3>
          {plan.files.length === 0 ? (
            <p className="mt-1 text-foreground">{t.planSection.noFile}</p>
          ) : (
            <ul className="mt-1 space-y-1 pl-5 text-foreground list-disc">
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
    </section>
  )
}

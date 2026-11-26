import { Link, useNavigate, useParams, useSearchParams } from 'react-router'

import { TaskDetailView } from '../../components/TaskDetail'
import { useCopy } from '../../lib/copy'
import { useEscape } from '../../lib/keys'

/** A task on a page of its own: the link the inbox and a shared address use. */
export default function TaskPage() {
  const id = Number(useParams().id)
  const navigate = useNavigate()
  const pass = Number(useSearchParams()[0].get('pass'))
  const { t } = useCopy()
  useEscape(() => void navigate('/work'))
  return (
    <TaskDetailView
      id={id}
      workbench
      focusRun={Number.isInteger(pass) && pass > 0 ? pass : undefined}
      above={
        <Link to="/work" className="text-sm text-muted-foreground hover:text-foreground">
          {t.work.backToBoard}
        </Link>
      }
    />
  )
}

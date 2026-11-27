import { useParams } from 'react-router'

import { CodeWorkbench } from '../CodeWorkbench'

/** Code Mode with one session open. */
export default function CodeSessionPage() {
  const { id } = useParams()
  return <CodeWorkbench openId={id} />
}

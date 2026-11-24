import { useLocation } from 'react-router'
import { Metadata } from 'theokit/client'

import { ChatView } from './components/chat/ChatView'
import { useCopy } from './lib/copy'

/** The empty conversation: where the owner starts, or goes back to, a new chat. */
export default function Page() {
  const { t } = useCopy()
  // A new chat from the menu changes this state, which is what starts the empty conversation over.
  const { state } = useLocation() as { state: { fresh?: number } | null }
  return (
    <>
      <Metadata title="aifactory" description={t.chat.metaDescription} />
      <ChatView key={state?.fresh ?? 'new'} />
    </>
  )
}

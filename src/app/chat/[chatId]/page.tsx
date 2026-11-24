import { useParams } from 'react-router'
import { Metadata } from 'theokit/client'

import { ChatView } from '../../components/chat/ChatView'
import { useCopy } from '../../lib/copy'

/** A conversation that was kept, reopened with what was said in it. */
export default function Page() {
  const { t } = useCopy()
  const { chatId } = useParams()
  return (
    <>
      <Metadata title="aifactory" description={t.chat.metaDescription} />
      <ChatView key={chatId} chatId={chatId} />
    </>
  )
}

import { useTheme } from '@theokit/ui'
import { CommandPalette } from '@usetheo/ui'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'

import type { TaskCard } from '../../../shared/panel'

import { get } from '../../lib/api'
import { useChats } from '../../lib/chats'
import { commands, targetOf } from '../../lib/commands'
import { useCopy } from '../../lib/copy'

/**
 * The palette: every place, the tasks that moved last and the conversations, found by typing. The tasks are
 * read when it opens, so a page that never opens it asks for nothing. A read that fails leaves the places and
 * the actions, which need no server.
 */
export function Palette({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t, language, setLanguage } = useCopy()
  const { mode, toggleMode } = useTheme()
  const { chats } = useChats()
  const navigate = useNavigate()
  const [tasks, setTasks] = useState<TaskCard[]>()

  useEffect(() => {
    if (!open) return
    let alive = true
    get<{ tasks: TaskCard[] }>('/api/panel/tasks')
      .then((answer) => {
        if (alive) setTasks(answer.tasks)
      })
      .catch(() => {
        if (alive) setTasks(undefined)
      })
    return () => {
      alive = false
    }
  }, [open])

  const items = useMemo(
    () => commands({ t, dark: mode === 'dark', tasks, chats }),
    [t, mode, tasks, chats],
  )

  const choose = (id: string) => {
    const target = targetOf(id)
    if (!target) return
    if ('to' in target) void navigate(target.to)
    else if (target.action === 'theme') toggleMode()
    else setLanguage(language === 'en' ? 'pt-BR' : 'en')
  }

  return (
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      items={items}
      onSelect={choose}
      placeholder={t.palette.placeholder}
      emptyMessage={t.palette.empty}
    />
  )
}

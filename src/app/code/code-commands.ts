import { CODE_MODES, type CodeMode, type CodeState } from '../../shared/code'

/** What a command does; `CodeConversation` runs each kind through the handler of the control it shortcuts. */
export type CommandAction =
  | { kind: 'mode'; mode: CodeMode }
  | { kind: 'model' }
  | { kind: 'rename' }
  | { kind: 'panel'; tab: 'changes' | 'files' }
  | { kind: 'stop' }
  | { kind: 'end' }

/** Why a command is refused; the words are in `t.code.commands.reasons`. */
export type CommandReason = 'sameMode' | 'ended' | 'notRunning'

/** The commands of the message box: the list, the filter and the handler all read this table. */
export const CODE_COMMANDS = [
  ...CODE_MODES.map((mode) => ({ name: mode, action: { kind: 'mode', mode } as CommandAction })),
  { name: 'model', action: { kind: 'model' } },
  { name: 'rename', action: { kind: 'rename' } },
  { name: 'diff', action: { kind: 'panel', tab: 'changes' } },
  { name: 'files', action: { kind: 'panel', tab: 'files' } },
  { name: 'stop', action: { kind: 'stop' } },
  { name: 'end', action: { kind: 'end' } },
] as const satisfies ReadonlyArray<{ name: string; action: CommandAction }>

export type CommandName = (typeof CODE_COMMANDS)[number]['name']
export type CodeCommand = (typeof CODE_COMMANDS)[number]

/** The reason the session's state refuses the command, or nothing when it runs. */
export function commandRefusal(
  action: CommandAction,
  session: { state: CodeState; mode: CodeMode },
): CommandReason | undefined {
  const ended = session.state === 'ended'
  switch (action.kind) {
    case 'mode':
      return ended ? 'ended' : action.mode === session.mode ? 'sameMode' : undefined
    case 'model':
    case 'rename':
    case 'end':
      return ended ? 'ended' : undefined
    case 'stop':
      return session.state === 'running' ? undefined : 'notRunning'
    case 'panel':
      return undefined
  }
}

/** The commands whose name starts with what was typed after the slash. */
export const matchCommands = (query: string): CodeCommand[] =>
  CODE_COMMANDS.filter((c) => c.name.startsWith(query.toLowerCase()))

/** The text is a bare `/word` (no space yet): the shape that opens the list. */
export const COMMAND_TEXT = /^\/(\S*)$/

/**
 * The command a text names when its first word is exactly `/<command>` and something follows it
 * (`/rename Rodada 8`): such a text is refused rather than sent to the agent. A slash that names no
 * command (`/tmp/file is missing`) is a message.
 */
export function commandWithArguments(text: string): CodeCommand | undefined {
  const words = /^\/(\S+)\s+\S/.exec(text.trim())
  const name = words?.[1]?.toLowerCase()
  return CODE_COMMANDS.find((c) => c.name === name)
}

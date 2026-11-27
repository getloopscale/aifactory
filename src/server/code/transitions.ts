import type { CodeState } from '../../shared/code'

/**
 * What happens to a code session for every state it can be in and every event that can reach it. Nothing
 * here reads or writes anything. A new state or event does not compile until every pair it adds has a row.
 *
 * `turn_released` gives a claimed turn back (the provider refused a sandbox, or the worker holding the claim went
 * quiet): the session is `queued` again and its message is still unanswered.
 *
 * `message` in `running` keeps the state: the message is stored unanswered, and the pass is handed it live or the
 * turn that ends queues the next one (`endTurn` in `store.ts`). `stop` in `running` names the state the session
 * ends in; it does not move it, since the process that holds the pass ends the turn and `turn_ended` moves it.
 *
 * `turn_started` comes twice in a turn: a worker takes a queued turn (`queued` to `starting`, the sandbox
 * comes up), then the agent starts working (`starting` to `running`).
 */

export const CODE_EVENTS = [
  'message',
  'turn_started',
  'turn_ended',
  'plan_proposed',
  'plan_answered',
  'stop',
  'idle_timeout',
  'end',
  'turn_failed',
  'turn_released',
] as const
export type CodeTransitionEvent = (typeof CODE_EVENTS)[number]

export type CodeOutcome =
  | { action: 'move'; state: CodeState }
  /** Nothing to do, and nothing wrong: the event came late or changes nothing. */
  | { action: 'ignored'; reason: string }
  /** Not allowed now; the reason is what a person reads. */
  | { action: 'refused'; reason: string }

const to = (state: CodeState): CodeOutcome => ({ action: 'move', state })
const ignored = (reason: string): CodeOutcome => ({ action: 'ignored', reason })
const refused = (reason: string): CodeOutcome => ({ action: 'refused', reason })

const GONE = 'The session has ended.'
const BUSY = 'The agent is working on the last message. Wait for it to finish or stop it.'
const NO_TURN = 'No turn is running.'

export const CODE_TRANSITIONS: Record<CodeState, Record<CodeTransitionEvent, CodeOutcome>> = {
  idle: {
    message: to('queued'),
    turn_started: refused('No turn is waiting to start.'),
    turn_ended: ignored(NO_TURN),
    plan_proposed: refused(NO_TURN),
    plan_answered: refused('No plan is waiting for an answer.'),
    stop: refused(NO_TURN),
    idle_timeout: to('stopped'),
    end: to('ended'),
    turn_failed: refused(NO_TURN),
    turn_released: refused(NO_TURN),
  },
  queued: {
    message: refused(BUSY),
    turn_started: to('starting'),
    turn_ended: refused(NO_TURN),
    plan_proposed: refused(NO_TURN),
    plan_answered: refused('No plan is waiting for an answer.'),
    stop: refused(NO_TURN),
    idle_timeout: ignored('The session has work waiting, so it is not idle.'),
    end: to('ended'),
    turn_failed: to('failed'),
    turn_released: ignored('The turn is already waiting.'),
  },
  starting: {
    message: refused(BUSY),
    turn_started: to('running'),
    turn_ended: refused(NO_TURN),
    plan_proposed: refused(NO_TURN),
    plan_answered: refused('No plan is waiting for an answer.'),
    stop: refused(NO_TURN),
    idle_timeout: ignored('The session is starting, so it is not idle.'),
    end: to('ended'),
    turn_failed: to('failed'),
    turn_released: to('queued'),
  },
  running: {
    message: to('running'),
    turn_started: ignored('The turn is already running.'),
    turn_ended: to('idle'),
    plan_proposed: to('waiting_input'),
    plan_answered: refused('No plan is waiting for an answer.'),
    stop: to('idle'),
    idle_timeout: ignored('The agent is working, so the session is not idle.'),
    end: to('ended'),
    turn_failed: to('failed'),
    turn_released: to('queued'),
  },
  waiting_input: {
    message: refused('The agent waits for an answer to its plan. Answer it first.'),
    turn_started: refused('The turn waits for an answer to the plan.'),
    turn_ended: refused(NO_TURN),
    plan_proposed: refused('A plan is already waiting for an answer.'),
    plan_answered: to('queued'),
    stop: refused(NO_TURN),
    idle_timeout: ignored('A plan waits for the owner, so the session stays as it is.'),
    end: to('ended'),
    turn_failed: refused(NO_TURN),
    turn_released: refused(NO_TURN),
  },
  stopped: {
    message: to('queued'),
    turn_started: refused('The session is stopped. Send a message to start it again.'),
    turn_ended: ignored('The session is stopped.'),
    plan_proposed: ignored('The session is stopped.'),
    plan_answered: refused('The session is stopped. Send a message to start it again.'),
    stop: ignored('The session is already stopped.'),
    idle_timeout: ignored('The session is already stopped.'),
    end: to('ended'),
    turn_failed: ignored('The session is stopped.'),
    turn_released: ignored('The session is stopped.'),
  },
  ended: {
    message: refused(GONE),
    turn_started: refused(GONE),
    turn_ended: ignored(GONE),
    plan_proposed: ignored(GONE),
    plan_answered: refused(GONE),
    stop: ignored(GONE),
    idle_timeout: ignored(GONE),
    end: ignored('The session has already ended.'),
    turn_failed: ignored(GONE),
    turn_released: ignored(GONE),
  },
  failed: {
    message: to('queued'),
    turn_started: refused('The last turn failed. Send a message to try again.'),
    turn_ended: ignored('The last turn failed.'),
    plan_proposed: ignored('The last turn failed.'),
    plan_answered: refused('The last turn failed. Send a message to try again.'),
    stop: refused(NO_TURN),
    idle_timeout: ignored('The last turn failed, so the session is not idle.'),
    end: to('ended'),
    turn_failed: ignored('The last turn already failed.'),
    turn_released: ignored('The last turn failed.'),
  },
}

export const transition = (state: CodeState, event: CodeTransitionEvent): CodeOutcome =>
  CODE_TRANSITIONS[state][event]

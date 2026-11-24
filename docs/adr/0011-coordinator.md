# ADR 0011: a coordinator handles the factory's exceptions, and a person only what is outside its limits

Status: accepted (2026-11-15).

## Context

The factory is a state machine. A task moves through declared stages (intake, plan, build, verify, review,
done, released, plus waiting, handoff, failed and cancelled), `factory/transitions.ts` says what each event
does in each stage, and three agents work inside it: the planner, the builder and the reviewer. The happy
path needs nobody. Its exceptions all end in the same place, "Needs a person", and the owner has been that
person, by hand, all day.

What the owner did by hand over the last seven days (stage events and decisions, read on 2026-11-15):

| Exception                                                        | Count            | What the owner did                                                                       |
| ---------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------- |
| Handoff: the reviewer still asked for changes after the attempts | 60               | Wrote a scope decision into the issue, filed the rest as a follow-up, sent the task back |
| Handoff: required checks failed and the agent changed nothing    | 16               | Sent it back with the failing output                                                     |
| Handoff: the review gave no usable verdict                       | 5                | Ran it again                                                                             |
| Failure: credentials or spend limits of the environment          | 70               | Fixed the environment, retried                                                           |
| Failure: a sandbox or network error, an agent that timed out     | about 60         | Retried                                                                                  |
| Done and integrated, waiting for a release                       | dozens at a time | Clicked Release                                                                          |
| A failure that repeated across tasks                             | #114, #115, #122 | Filed an issue so the factory fixed itself                                               |

There were 184 retries, 58 requests for changes and 43 releases made by a person in that week. The pieces
an agent would use already exist: the transition table, the `supervise` cron and its findings, the
indicators with control bands in `metrics/`, the panel's actions, and the automatic retry and send-back
that `requeue` records without a decision in anybody's name.

## Decision

A coordinator sits above the state machine. It has four functions, each a module of
`src/server/coordinator/`, run by one cron, `coordinate`, every ten minutes.

### 1. Monitor: exceptions over facts

`exception-facts.ts` reads (tasks in `handoff`, `failed` and `done`, their last events, supervisor findings,
the queue). `exceptions.ts` decides over those facts and reads nothing, the split the doctor uses. An
exception has a kind, the task, the head it was seen on and the evidence it was recognised by. A fact that
could not be read is an exception of kind `unknown`, never the absence of one.

### 2. Coordinate: one action from a closed set, applied by code

`decide.ts` is a pure function from an exception and the actions already taken to one action:

| Exception                                        | Action                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `review_plateau`                                 | `scope`: decide which of the reviewer's requests belong to the issue, write that decision into the issue, file the rest as a follow-up issue, send the task back on its branch                                                                                                                                                                                                                                   |
| `checks_unchanged`                               | `send_back`: on its branch, with the output of the check that failed                                                                                                                                                                                                                                                                                                                                             |
| `review_unusable`                                | `review_again`: a continuation on the same branch; with nothing new to commit, the same commit goes to the checks and the review again                                                                                                                                                                                                                                                                           |
| `release_ready`                                  | `release`: the release train of ADR 0010, as a playbook of the coordinator                                                                                                                                                                                                                                                                                                                                       |
| `queue_blocked`                                  | `prioritise`: a test failed on two or more tasks of a repository within six hours and a queued task carries it; its pending `run-task` job goes just ahead of the repository's other pending jobs (`available_at`), and those jobs are held until the fix integrates, fails, waits for an answer or is handed to a person, then get their own `available_at` back. One decision per attempt of the fix (its job) |
| `stalled` or `orphaned` finding                  | `retry_from_finding`, as the panel does                                                                                                                                                                                                                                                                                                                                                                          |
| `environment` failure past its automatic retries | `escalate`: the task stays with a person, with what the coordinator read                                                                                                                                                                                                                                                                                                                                         |
| anything else, or a limit reached                | `escalate`                                                                                                                                                                                                                                                                                                                                                                                                       |

`apply.ts` is the only module with side effects. It calls the actions that already exist
(`requeue`'s automatic kinds, `resolveFinding`, `release()`), each of which asks `transitions.ts` first,
plus two GitHub writes the scope needs: the issue body and a new issue. Nothing else.

A model is used only to draft text: the scope decision, the follow-up issue and the issue an evolution
files. It is built with `buildAssistant`, so it has the knowledge base's two read tools and nothing else,
its answer is parsed with a Zod schema, and an answer that does not parse is an `escalate`. The model never
picks the action.

This is how "Side effects get a human" is kept. A tool an agent calls in a conversation still asks the
owner. The coordinator calls no tool: code applies an action from a fixed list, each action already
allowed by the transition table, and records it, as the automatic retry and send-back already do.

### 3. Every decision is recorded

The `coordinator_action` table holds one row per decision, applied or not: the task, the exception kind,
the head, the action, the reason a person reads, what the model drafted, the outcome (`applied`, `trial`,
`refused`, `failed`, `escalated`) and the time. A unique key on task, exception kind and head means one
exception gets one action per head. A task gets at most two applied actions; the third exception of the
same task is an `escalate` naming what was tried. The panel shows these rows on the task and in a list.

`FACTORY_COORDINATOR_MODE` is `off`, `trial` (decide and record, apply nothing) or `auto`. It starts in
`trial`.

### 4. Evaluate: the factory against its own baseline

Three indicators join `metrics/config.ts`: the share of finished runs that ended in a handoff, the person's
decisions per delivered task, and the share of the coordinator's applied actions whose task reached `done`
or `released` with no person after. The control bands already say when a number left its usual range. A
weekly point compares each indicator with the four weeks before the coordinator's first applied action,
which is the baseline, and says better, worse or no change.

### 5. Evolve: a failure that repeats becomes an issue for the factory

`evolve.ts` groups failures and handoffs by signature: the reason with numbers, commit ids and paths
replaced. A signature seen on three or more tasks in seven days, not one of the designed waits (blocked by
another issue, waiting for an answer), with no issue already filed for it, becomes an issue on
`paulohenriquevn/aifactory` with the `factory` label: the signature, the tasks, their events and a repro.
The `failure_signature` table remembers the issue. At most one such issue per pass and three per week.
When the issue closes, the coordinator counts the signature in the seven days after the release that
closed it against the seven days before it was filed, records both, and comments on the issue when the
count did not fall.

## Limits, enforced in code

- **The coordinator merges nothing.** No module under `coordinator/` calls a merge; a test fails if one
  does. A revert pull request stays for a person.
- **No major release without the `breaking` label.** `release_ready` asks `release()` for minor or patch,
  and for major only when the issue carries `breaking`.
- **No quality gate is loosened.** The coordinator writes no file of any repository. A send-back runs
  through the same checks, test-weakening guard and review as any run, and a drafted note that names a
  quality configuration (`quality/`, the Stryker, jscpd or coverage settings) is refused and escalated.
- **Sensitive changes to the factory never go live alone.** A person deploys the factory today, and
  nothing in the coordinator deploys. When the self-deploy of the plan's phase G exists, it refuses a range
  that touches the prompts, `review.ts`, `evidence.ts` or `test-weakening.ts` until the evaluations pass and
  the owner approves.
- **The environment is a person's.** Credentials, spend limits and the GitHub App are never retried past
  their automatic retries; they are escalated with what was read.

## Consequences

- "Needs a person" becomes the exceptions the coordinator escalated, each with its reason, instead of
  every exception.
- An action is now possible with nobody watching. The audit table, the two-action cap per task and the
  `trial` start are what make that reviewable before it is trusted.
- The release train of ADR 0010 is built as the `release_ready` playbook instead of its own cron, with the
  rules that ADR set. Its three changes to `AGENTS.md` go in when the playbook ships.
- A model call costs money on every plateau. It is one call per exception per head, recorded with its cost.

## Alternatives considered

- **Give an agent the panel's actions as tools.** One prompt injection in an issue would then reach a
  merge or a release. A closed set applied by code keeps what the model can do to drafting text.
- **Keep a person on every exception.** It is what exists, and it is the cost this ADR measures.
- **A separate cron per exception.** The supervisor, the release train and the evolution would each keep
  their own idea of what was already tried on a task. One coordinator keeps one record and one cap.
- **Reorder the queue.** The factory runs one task at a time and the order has not been the bottleneck in
  the data above. It waits until it is.

## Amendment: the unblocker (#251)

What the closed set has no action for, and what reached `MAX_APPLIED`, goes to an unblocker agent before a
person. `coordinator/unblock.ts` holds the closed set of its answers, how an answer is read and what each one
decides (pure, tested without a model); `coordinator/unblocker.ts` calls the model (built by
`buildAssistant`, read-only tools, `onlyTools`) and hands the answer to that module. The split is the one
`scope.ts` and `draft.ts` already make. An answer that does not parse, or an `escalate` with no owner
category, is an `escalate`; the unblocker has a cap of its own (three applied actions per task and head).

Phase 1 needs no model: `checks_unchanged` without kept output is sent back with the failing job logs of the
pull request head, one on a conflicting pull request is a `merge_base`, and a check that failed on the pull
request but passed on the factory's run of the same commit is rerun once per commit (`rerun_checks`).

`resolve_elsewhere` takes a commit the integration branch holds. The issue also names "a passing run", but a
run proves nothing the factory can read about where the work landed, so a run alone is refused. The agent
configuration is held for `pnpm evals:check` and merged by the owner, as the rules require.

The cap of three unblocker actions is counted per task and head, but a decision is already unique per task,
exception kind and head, so it binds only across different kinds on one head; the head of an exception is not a
durable identity across reruns, so a new head starts a new count. `security` and `unknown` never reach the
unblocker: only a person adds a security exception, and a failed read is waited out. A `blocked_by` on a task that
stopped queues its run again (which waits on the blocker); on a task waiting for an answer it is refused, since
nothing reads the line there.

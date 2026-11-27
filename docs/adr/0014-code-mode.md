# ADR 0014: Code Mode, a place to write code with an agent

Status: **accepted, 2026-11-27**.

## Context

The panel has chats with the factory's assistants. They run in the server process, where the factory's
credentials are, and may call only the tools they declare (`onlyTools`). The owner also wants to write code
with an agent from the panel, outside a task: ask about a repository, plan a change, make it, and leave a
branch behind. Code Mode is tracked in #619.

The design comes from the owner's decision of 2026-11-27 and from a study of a hosted coding agent's web
interface made the same day. This ADR records the decisions and what was rejected; it does not reopen them.

## Decision

1. **Code Mode is a place of its own in the panel menu**, called "Code Mode", at `/code`. It is not a selector
   inside the existing chats.
   - Rejected: a mode selector in every chat. The assistants of the chats run in the server process and may
     only call the tools they declare, and an agent that edits code there is a shell on the host.
2. **A code session has a workspace**: one sandbox built by `createIsolatedSandbox` with the checkout of one
   enabled repository on a work branch of its own. The agent runs only in that sandbox. Credentials stay in
   the firewall.
3. **The agent is a `CodingHarness` from the harness registry** (`factory/harness-registry.ts`). Claude Code
   and Codex are there today. LoopCode joins as one more harness once `@getloopscale/loopcode` is published
   (getloopscale/loopzero#2).
   - Rejected: speaking ACP to an agent from the server before any session works end to end.
4. **A session is a numbered log of events** (`code_event`, `seq` per session). The panel reads from a
   sequence number and follows the stream, so a reload or a second device sees the same session.
5. **Three permission modes: Ask, Plan and Code.** Ask and Plan run the harness read-only
   (`HarnessInput.ask`), Code lets it write. The mode is enforced by how the harness is started, never by the
   prompt alone.
6. **A turn is a job** (`code-turn`), one writer per session, which waits in the queue for a sandbox slot like
   a run does.
7. **Code Mode never merges.** What leaves a session is a pushed branch and a draft pull request. Integration
   is the factory's existing path.
8. **A stopped workspace is a snapshot**; the next message restores it. This is specific to Code Mode: ADR 0013
   restores the agent's session folder of a task's run and takes no snapshot. How the snapshot is stored is
   left to the implementation.

## Consequences

- The agent never runs in the server process, so the `onlyTools` rule of the chats is untouched.
- The panel needs the `/code` routes, the `code_event` table, the `code-turn` job and a `code/` area under
  `src/server/`; each is a separate issue.
- A read-only mode depends on each harness's own flag, so a new harness must declare how it honours `ask`.
- A turn waits for a sandbox slot, so a busy account delays a session and never fails it.
- Because nothing merges from a session, work started in Code Mode reaches the integration branch only
  through the factory's path.

# Spikes S2 and S3: reach a running agent, and resume a session in a new sandbox (M13)

**Area:** run (`src/server/factory/`), harnesses (`harness-claude.ts`, `harness-codex.ts`)
**Path:** panel
**Blocks:** M13 (conversa com os agentes), issue #472

## Why

M13 depends on two facts nobody has verified (`docs/PLAN.md`, "M13"). If either spike fails, the plan says
the design is rewritten before any code. #472 is paused until both are done and ADR 0013 holds the result.
Neither spike changes application code: they run with real credentials in a real sandbox and write down what
happened.

## S2: reaching a running process

Run, in a real sandbox, with Claude and with Codex:

1. Claude with `--input-format stream-json`: a message sent over stdin while a step runs is handled on the
   next turn and the step in progress is not lost.
2. A mailbox file read by a `PostToolUse` or `UserPromptSubmit` hook, for both harnesses where hooks exist.
3. Interrupt and resume: kill the process, run `--resume` with the message.
4. Whether `codex exec` accepts input after it started (the `app-server` is experimental).
5. Whether `--permission-mode plan` (Claude) and `--sandbox read-only` (Codex) prevent every write. If not,
   the guarantee for "ask" becomes a check of the branch SHA after the answer.

## S3: resuming a session in a new sandbox

1. Copy the CLI's session file out of the sandbox at the end of a run (Claude's session file, Codex's
   sessions folder).
2. Start a new sandbox cloned from the branch, restore the file, run `claude --resume <id>` and
   `codex exec resume <id>`.
3. Ask about something said before the restoration. The answer must show the conversation continued.
4. Note what the Docker sandbox (cannot save its disk) and E2B (session ends after an hour) allow.

## Done when

- [ ] ADR 0013 holds, for S2, which path works for Claude and for Codex, and the decision between stdin,
      mailbox and interrupt-and-resume.
- [ ] ADR 0013 says whether "ask" mode is enforced by the CLI flags or by the SHA check.
- [ ] ADR 0013 holds, for S3, whether a restored session continues the conversation, for both harnesses,
      with the evidence (the question asked and the answer).
- [ ] ADR 0013 states whether the M13 design stands or what changes; `docs/PLAN.md` M13 is updated to match.
- [ ] The framework gap is linked: paulohenriquevn/aifactory#492.

No application code in this issue. The result is documents only.

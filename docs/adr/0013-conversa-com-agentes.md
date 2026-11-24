# ADR 0013 — Conversation with the agents (M13)

Status: **pending**. The spikes below have not run. No code for M13 is written until they have.

## Context

M13 lets the owner write to an agent that is working and to one that stopped. The design rests on two
unverified facts. The spikes are described in `docs/issues/spikes-s2-s3.md`; the framework gap is
paulohenriquevn/aifactory#492.

## S2: reaching a running process

Not run. To record: the result for Claude and for Codex of stdin (`--input-format stream-json`), a mailbox
read by a hook, and interrupt and resume; whether `codex exec` takes input after it started; whether
`--permission-mode plan` and `--sandbox read-only` prevent every write.

## S3: resuming a session in a new sandbox

Not run. To record: whether `claude --resume <id>` and `codex exec resume <id>` continue the conversation in
a new sandbox with the session file restored from `agent_session`.

## Decision

Pending the results. If either spike fails, the M13 design in `docs/PLAN.md` is rewritten before any code.

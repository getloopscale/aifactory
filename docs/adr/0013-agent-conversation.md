# ADR 0013: conversation with the agents (spikes S2 and S3)

Status: **accepted, verified 2026-11-25**.

## Context

M13 (`docs/PLAN.md`) depends on two answers that only a real sandbox gives:

- **S2:** does a message reach the running process? Does the step in progress survive? Does ask mode
  (Claude `--permission-mode plan`, Codex `--sandbox read-only`) prevent writes?
- **S3:** does the CLI's session, saved outside the sandbox and restored in a new one, answer about a fact
  told before?

## Execution

Both spikes ran on 2026-11-25 in live E2B sandboxes, with real Anthropic and ChatGPT credentials attached by
the firewall, through the factory's own path (`sandboxProviderFromEnv`, `createIsolatedSandbox`, each
harness's `egress()` and `prepare()`). The script is `spikes/e2b/agent-conversation.test.ts`, with a vitest
config of its own; it skips unless `SPIKE_CLI` is set, so no suite runs it:

```
SPIKE_CLI=claude|codex [SPIKE_ONLY=stdin] node --env-file=.env.local node_modules/vitest/vitest.mjs run \
  --config spikes/e2b/vitest.config.ts
```

Claude Code 2.1.319 and codex-cli 0.166.0, the versions the factory pins. Codex used the subscription login
(`FACTORY_CODEX_AUTH=subscription`). One run per CLI, plus one rerun of the stdin part.

## Results (observed)

| Question                                                                                  | Claude                                                                                                                                                                                                                                       | Codex                                                                                                                                                            |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ask mode leaves the tree and HEAD untouched when asked to edit `f.txt` and create `g.txt` | yes: `git status --porcelain` empty, `f.txt` unchanged, HEAD unchanged (`--permission-mode plan`)                                                                                                                                            | yes, same checks (`--sandbox read-only`)                                                                                                                         |
| stdin reaches a running turn                                                              | yes: with `-p --input-format stream-json --output-format stream-json`, a second message written 15 s into a turn running a 50 s command was answered in that turn's result (`<code>\n\nfinished`), before end of input; the command finished | no: `codex exec -` reads stdin to EOF before it starts; 0 bytes of output before EOF, and after EOF only the first message was handled and its command never ran |
| `--resume <id>` / `exec resume <id>` while a turn of the same session runs                | answered in 2.8 s and recalled the earlier fact; the running turn still finished                                                                                                                                                             | answered in 3.2 s, recalled; the running turn still finished                                                                                                     |
| Session restored in a new sandbox from the session folder alone, same `cwd`, then resumed | recalled the fact; archive 132,616 bytes gzipped (`~/.claude/projects`)                                                                                                                                                                      | recalled the fact; archive 118,810 bytes gzipped (`~/.codex/sessions`)                                                                                           |

Notes on reading them:

- The parallel resume is **not delivery to the running process** (inferred): it is a second process on the
  same session that sees the history up to then; nothing tells the running turn about the message. Two
  writers on one session is what M13's rule "one writer per instance" forbids. Do not use it.
- Claude refused a bare `sleep 45` in the first stdin attempt ("the harness blocks a plain sleep"); the rerun
  used `timeout 50 tail -f /dev/null`. This is the CLI, not the delivery.
- Ask mode was tested against one plain write request, not every write path (`sed -i`, redirection, `git`).
  The post-answer check below is the guarantee.
- The archives were taken with the CLI's credential as a placeholder (the real one is attached by the
  firewall), so the folder cannot hold the secret (inferred). Codex's login file is `~/.codex/auth.json`,
  outside `~/.codex/sessions`, so it is not in the archive.

## Decision

- **Running Claude instance: deliver through stdin.** The CLI runs with `--input-format stream-json` and reads
  from a file the factory appends to inside the sandbox (`tail -f <inbox> | claude ...`), since
  `SandboxBackend` has no stdin for a running command. Each message is one JSON line written with
  `uploadFile` and appended, never through a shell, like issue text.
- **Running Codex instance: interrupt and resume.** The panel says the message stops the current step.
- **Stopped instance (both):** save only the session folder to `agent_session` at the end of every run and
  restore it, in a sandbox cloned from the branch with the same `cwd`, before `--resume <id>` /
  `exec resume <id>`. No snapshot.
- **Ask mode:** `--permission-mode plan` / `--sandbox read-only`, plus a check of `git status --porcelain`
  and HEAD after the answer; any change is discarded and the message is marked failed with the reason.
- **Mailbox read by a hook:** not run and not needed: stdin covers Claude, and Codex has no hooks.
- **The M13 design stands with these two changes; no rewrite:** Codex has no delivery to a running process,
  and a parallel `--resume` is not delivery.

## Consequences

The implementation is split into separate issues; this ADR records the evidence and the choice only.

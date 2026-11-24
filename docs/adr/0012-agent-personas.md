# ADR 0012 — Agent personas

## Context

The builder, reviewer and planner prompts list rules but never say who the agent is, its one job or what
it never does. The limits of a role hold only while the model obeys the prompt. Three failures were measured
on 2026-11-16: "the agent made no change", running out of time before the review, and reviews that do not
converge (`review_plateau`).

## Decision

1. Each role has a persona (`src/shared/personas.ts`, prompts in `src/server/agents/prompts/personas.ts`): a
   name, one job, what it never does and how it sounds. `personaPreamble(role)` opens every prompt of the role.
2. Each coding role gets a Claude Code plugin (`src/server/factory/agent-plugin.ts`), loaded with
   `--plugin-dir /tmp/factory-plugin-<role>`: the role's skill and a `PreToolUse` guard. The guard denies only
   what the rules already forbid: `git commit` and `git push` for every role, edits for the reviewer and the
   planner, and edits under `.github/` for the builder. Other git commands stay allowed, since the factory's own
   notes ask for them (for example `git merge origin/<base>` on a conflict send-back).
3. The persona shows on the agents page and in transcript labels, and a neutral signature ends the pull request
   body, the factory's question and the issues Evolve files.

The guard is a role guard, not a security boundary; the sandbox remains the boundary.

## Consequences

The change touches agent configuration, so the owner runs `pnpm evals:check` against the recorded baseline and
merges the pull request.

# Evals: why the cost per case rose about 60% (#72)

Range: `6385b0a` (baseline run, 2026-11-11 21:24Z = 18:24 -03) to `23a76d8` (run of 2026-11-12).

## Cause

The baseline measured a path the factory no longer runs. Two commits, both after the baseline run started, add work to every new task:

| Commit                                                 | Time (-03)  | What it adds                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `48d2c7c` Plan the change before building it           | 11-11 18:08 | `Run.planChange`: a planning turn of the builder (the full build prompt plus the "plan only" instructions, `changePlanPrompt`), a `planAgain` turn when the answer has no readable plan, then the build resumes that session with `implementPlanPrompt`. The plan, the files changed outside it and the builder's summary (up to 3,000 characters) go into the reviewer's prompt (`planSection`). |
| `1020a1f` Run evaluation cases with the builder's plan | 11-11 18:59 | The same steps in `evals/run-case.ts`. Before it, the runner went straight to the build and the review without a plan.                                                                                                                                                                                                                                                                            |

The baseline was recorded at 18:24, 35 minutes before `1020a1f`, so its cases ran with one builder turn and a reviewer prompt with no plan. Every later run has two builder turns (plan, then build) and a longer reviewer prompt. The planning turn re-reads the issue, the rules and the code, and the reviewer pays again for the plan. Nothing else in the range touches the prompts, the knowledge slice or the number of review rounds (`git diff 6385b0a 23a76d8 -- src/server/agents .theokit` shows one line in `agents/tools/chat.ts`); `23a76d8` adds a few lines to the reviewer's prompt when a factory check required files.

## Evidence

Taken from `evals/baseline.json` at `d86a889` (the baseline) against the figures in the issue. Cost in US$ per case:

| Case                    | Baseline (no plan) | 23a76d8 (plan) | Change |
| ----------------------- | ------------------ | -------------- | ------ |
| aifactory-playground#61 | 0.090              | 0.14           | +55%   |
| theokit#1685            | 0.096              | 0.17           | +77%   |

Both are small cases that ran in one attempt and one review round in the baseline (`attempts: 1`, `reviewRounds: 1`), so the added cost is not retries: it is the planning turn plus the longer review. The two cases whose cost moved the other way or by a different amount (theokit-gateways#348, theokit-plugins#235, theokit-sdk#975) took 2, 1 and 1 attempts and their cost follows the attempt count more than the plan.

## What was not measured

The run transcripts and the stored per-role token counts live in the factory's database and in the evaluation runs' sandboxes, not in this checkout, and this pass had no access to them. So tokens or turns by role are **not** measured here: the attribution above is from the commit history and the code, and it fits the size and timing of the rise, but it is not a per-role count. To close it, re-run `aifactory-playground#61` twice on `23a76d8`, once with `planFirst: false` in the deps (the switch `planChange` already reads) and once with the default, and compare cost, turns and tokens for builder and reviewer. The difference is the cost of the plan.

## Decision for the owner

The plan is a deliberate feature (ADR 0008), so the rise is expected rather than a regression. The remaining step is the owner's: accept the cost and record a new baseline on the current setup (a full `pnpm evals` run, see `suite.evals.test.ts`), or shorten the planning turn. The comparison itself now ignores a case that failed before a verdict, so a failed case at zero cost can no longer hide the rise.

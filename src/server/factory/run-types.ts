import type { untilSlotFree } from './sandbox-slot'
import type { Recipe } from './recipe'
import type { KnowledgeSource } from '../knowledge/source'
import type { Database } from '../db'
import type { question as questionTable } from '../db/schema'
import type { FetchLike, GithubApp } from '../github/app'
import type { Issue } from '../github/issues'
import type { GithubApi } from '../github/pulls'

import type { ReleaseMode } from './deliver'
import type { CheckSpec } from './evidence'
import type { CodingHarness } from './harness'
import type { IsolatedSandboxProvider } from './sandbox'

/**
 * Why a run handed its work to a person, as the handoff event records it next to its `reason`: the review
 * did not converge in the attempts, the review gave no verdict, the required checks failed and the agent
 * changed nothing, or the last rework broke the checks and the branch went back to the last reviewed commit
 * that passed them (`checks_broke_after_review`, a problem of the checks, not of the review). The coordinator
 * reads it (`coordinator/exceptions.ts`).
 */
export type HandoffCause =
  | 'review_plateau'
  | 'review_unusable'
  | 'checks_unchanged'
  | 'checks_broke_after_review'
  | 'agent_configuration'
  /** The security review of approved work blocks it and no agent may waive that (`Run.secured`, #457). */
  | 'security'
  /** Integrated work whose pull request still conflicts with its base after the automatic runs (`ci-wait.ts`). */
  | 'pull_conflict'
  /** The base passes the checks blamed on it again, and the pull request still has to merge it (`ci-wait.ts`). */
  | 'base_fixed'
  /** The required checks of the pull request still fail after the automatic runs (`ci-wait.ts`). */
  | 'ci_red'

export type HarnessChoice = CodingHarness | ((labels: string[]) => CodingHarness)

export type RunTaskDeps = {
  db: Database
  github: GithubApp
  sandbox: IsolatedSandboxProvider
  /** One agent for every task, or a function that chooses it from the issue's labels. */
  harness: HarnessChoice
  /**
   * The independent reviewer. A function may return nothing, and the builder then reviews its own
   * work in a fresh session, which is weaker: set a different agent for a real second opinion.
   */
  reviewer?: CodingHarness | ((labels: string[]) => CodingHarness | undefined)
  /**
   * The security reviewer of approved work, at the highest effort its engine offers (`securityOptions`). When this
   * is set the review runs before every merge, and a function that returns nothing means the agent cannot start:
   * the work goes to a person and is never approved without it. Not set, the step is not part of this run.
   */
  security?: (labels: string[]) => CodingHarness | undefined
  /**
   * The agent that resolves the conflicts of merging the integration branch into approved work (#227). Nothing
   * (or no function) means the builder's agent does it in a fresh session.
   */
  merger?: CodingHarness | ((labels: string[]) => CodingHarness | undefined)
  /**
   * The agent that writes the change plan, apart from the builder, chosen from the issue's labels and the
   * builder's name. Nothing (or no function) means the builder plans in the session it then builds in.
   */
  planner?: (labels: string[], builder: string) => CodingHarness | undefined
  /** The commit author, so the pull request shows who wrote it. */
  author: { name: string; email: string }
  fetchIssue?: (repo: string, number: number, token: string, fetch?: FetchLike) => Promise<Issue>
  githubApi?: GithubApi
  /**
   * What the factory does with a release, the promotion of its work to the default branch. It always
   * makes a pre-release. `manual` (the default) leaves the release to a person, `trial` records what
   * an agent would have released, and `auto` releases a commit with green checks and an approval.
   */
  releaseMode?: ReleaseMode
  /** What must pass on the pushed commit before a pull request opens. */
  checks?: CheckSpec[]
  /**
   * The factory's own repository, whose agent configuration it never integrates on its own
   * (`heldForEvaluation`). `FACTORY_REPOSITORY` unless a fork names its own.
   */
  ownRepository?: string
  /**
   * Whether the builder writes a plan before it changes anything (on unless false). A builder that cannot
   * resume a session never does, since the plan would not reach the turn that does the work.
   */
  planFirst?: boolean
  timeouts?: { sandboxMs: number; agentMs: number; checkMs?: number; reviewMs?: number }
  /** Wait between push attempts. */
  pushRetryDelayMs?: number
  /** How the run waits for a free sandbox slot before it starts (`untilSlotFree`); the tests pass a clock. */
  slotWait?: Parameters<typeof untilSlotFree>[1]
  /**
   * Where the knowledge base comes from. Every agent the run starts reads it at `/tmp/knowledge`, kept
   * current while it works; without a source (the tests) the agents work without one.
   */
  knowledge?: KnowledgeSource
  /**
   * Reads the project's `.factory/setup.json` from its default branch on GitHub. Without it (the tests)
   * a run uses only what the owner set in the panel.
   */
  fetchRecipe?: (repo: string, token: string) => Promise<Recipe | undefined>
}

export type RunResult =
  | {
      status: 'done'
      branch: string
      sha: string
      pullRequestUrl: string
      summary: string
      preRelease?: string
      released?: string
    }
  | {
      status: 'handoff'
      branch: string
      sha: string
      pullRequestUrl: string
      reason: string
      preRelease?: string
    }
  /**
   * The review approved the work and the task waits in `merge` for its `merge-task` job, which opens the pull
   * request and integrates it (`factory/merge-task.ts`). The run's part succeeded.
   */
  | { status: 'merging'; branch: string; sha: string; summary: string }
  /** The code already did what the issue asks: the checks passed there, the reviewer agreed, the issue is closed. */
  | { status: 'resolved'; sha: string; summary: string }
  | { status: 'waiting'; question: string }
  | { status: 'failed'; stage: string; error: string }
  /** The task was cancelled while the run went on: it stopped at `stage` and recorded nothing more. */
  | { status: 'cancelled'; stage: string; reason: string }
  /** The provider refused the sandbox for credit or spending: nothing failed, the job queues itself again. */
  | { status: 'deferred'; stage: string; reason: string }

type QuestionRow = typeof questionTable.$inferSelect

/** A question that parked a run, taken back to be resumed: an agent's, with the sandbox it left. */
export type Parked = QuestionRow & {
  snapshotId: string
  sessionId: string
  harness: string
  repoDir: string
  baseSha: string
  attempt: number
}

/**
 * The question as a parked run, or an error naming what is missing: only an agent's question left a sandbox
 * to resume, and a readiness question (`scheduler/`) was asked before any run.
 */
export function parkedOf(row: QuestionRow): Parked {
  const { snapshotId, sessionId, harness, repoDir, baseSha, attempt } = row
  if (
    row.origin !== 'agent' ||
    snapshotId === null ||
    sessionId === null ||
    harness === null ||
    repoDir === null ||
    baseSha === null ||
    attempt === null
  ) {
    throw new Error(
      `question ${row.id} of task ${row.taskId} was asked by ${row.origin} and left no sandbox to resume`,
    )
  }
  return { ...row, snapshotId, sessionId, harness, repoDir, baseSha, attempt }
}

import { randomUUID } from 'node:crypto'

import type { SandboxBackend } from '@getloopscale/loopzero-agents/sandbox'

import {
  DEFAULT_CHECK_MS,
  DEFAULT_REVIEW_MS,
  NoTimeForAgent,
  agentTimeLeft,
  fitToSession,
} from '../factory/agent-time'
import {
  changePlanPrompt,
  givenPlanPrompt,
  implementPlanPrompt,
  parseNewChangePlan,
  planAgainPrompt,
  renderChangePlan,
  type ChangePlan,
} from '../factory/change-plan'
import type { CodingRole } from '../factory/agent-plugin'
import { BaseProbe, sameChecks } from '../factory/base-checks'
import { cloneRepository } from '../factory/clone'
import { prepareDeclaredPackageManager } from '../factory/package-manager'
import { uploadChangesetCheck } from '../factory/changeset-check'
import {
  failedInstall,
  failingChecks,
  prepareInstall,
  runChecks,
  type CheckResult,
  type PreparedInstall,
} from '../factory/evidence'
import { FIX_COMMIT_MESSAGE, runFixes } from '../factory/fixes'
import type { RiskAssessment } from '../../shared/panel'
import { assessmentFor, assessRisk } from '../factory/risk'
import { diffFacts, securityDiff, securityFloor, securitySurfacesOf } from '../factory/diff-facts'
import {
  decideSecurity,
  skippedBecause,
  findingKey,
  parseSecurityVerdict,
  securityPrompt,
} from '../factory/security-review'
import {
  LENSES,
  decideLens,
  documentPaths,
  lensModeFromEnv,
  parseLensVerdict,
} from '../factory/lens-review'
import type { CheckRun, RequiredByCheck } from '../factory/required-files'
import {
  buildPrompt,
  type CodingHarness,
  type HarnessInput,
  type HarnessResult,
} from '../factory/harness'
import {
  blockingCount,
  OUTSIDE_THE_PLAN,
  parseVerdict,
  withAcceptance,
  reviewAllowsRework,
  reviewPrompt,
  reworkPrompt,
  type EarlierReview,
  type Finding,
  type ReviewVerdict,
} from '../factory/review'
import { DEFAULT_TIMEOUTS, PLAN_MS } from '../factory/run'
import {
  addsProofFinding,
  blockedByProof,
  proveTests,
  provedOnce,
  testProofModeFromEnv,
  type TestProof,
} from '../factory/test-proof'
import {
  COMMIT_MESSAGE,
  GITCONFIG,
  INSTANCE,
  MAX_CHECK_REWORKS,
  gitConfig,
  must,
  oneLine,
} from '../factory/run-support'
import {
  createIsolatedSandbox,
  type IsolatedSandbox,
  type IsolatedSandboxProvider,
  type SandboxSpec,
} from '../factory/sandbox'
import { parseQuestion } from '../factory/waiting'
import { KnowledgeFeed } from '../knowledge/feed'
import type { KnowledgeSource } from '../knowledge/source'

import type { EvalCase } from './cases'
import { caseOutcome, MEASURED_ITS_BASE, type CaseEnd, type CaseResult } from './compare'
import { whenSlotFree } from './sandbox-slot'

export type EvalDeps = {
  sandbox: IsolatedSandboxProvider
  builder: CodingHarness
  reviewer: CodingHarness
  /** The agent that writes the plan when it is not the builder, as `Run.planChange` uses it. */
  planner?: CodingHarness
  /**
   * The security reviewer of approved work, as `Run.secured` uses it. `null` is an agent that could not start,
   * which blocks every approval; left out, the case has no security step.
   */
  security?: CodingHarness | null
  author: { name: string; email: string }
  /** The knowledge base every agent reads; left out, the agents work without one. */
  knowledge?: KnowledgeSource
  /** The limits a run of the case's repository has (`resolveTimeouts`); left out, the factory's default. */
  timeouts?: typeof DEFAULT_TIMEOUTS
}

/** A case that ended before a verdict: the agent stopped, asked something, or changed nothing. */
class Stopped extends Error {}

const COMMIT = /^[0-9a-f]{40}$/

const ABANDONED = 'abandoned: the suite ran out of time'

/** Ends an abandoned case where it stands, so it starts nothing more. */
function ensureLive(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Stopped(ABANDONED)
}

/**
 * One case run the way the factory runs a task (`factory/run.ts`): the same prompts, agents, plan, checks,
 * facts about the diff and review, and the same budgets: `MAX_CHECK_REWORKS` for failing checks and the review's own rounds. A step added to `Run` is added here too,
 * or the suite measures a factory that no longer exists. It writes nowhere but the sandbox: GitHub is
 * reachable without a credential, so the clone works and a push cannot, and nothing here pushes, opens a
 * pull request or records a stage.
 */
class CaseRun {
  /** The last review that asked for changes: the next round starts from its findings. */
  private earlier: EarlierReview | undefined
  /** What the builder said to the last review's findings, kept across a check rework. */
  private reviewAnswer: string | undefined
  cost = 0
  private reviewerCost = 0
  private securityCost = 0
  private lensCost = 0
  private lensReworks = 0
  private lensEarlier: Finding[] = []
  /** A review gave a valid verdict at some point of the case. */
  private verdictSeen = false
  attempts = 1
  reviewRounds = 0
  /** The verdict of each review round that completed, as it came back. */
  readonly reviews: ReviewVerdict[] = []
  /** The findings that block, in each review round so far. */
  private readonly blockingCounts: number[] = []
  /** The reworks failing checks asked for, apart from the review's rounds, as `Run.loop` counts them. */
  private checkReworks = 0
  /** The last commit this case made or found, from which the next round counts what the builder committed. */
  private committed: string | undefined
  /** The last commit the fixes ran on or made, so they never run twice on the same commit, as in `Run`. */
  private fixedHead: string | undefined
  private sessionId: string | undefined
  /** What the builder meant to change, written before it changed anything. */
  private plan: ChangePlan | undefined
  /** What the builder said when it last finished, where it gives its reasons. */
  private summary = ''
  /** Every result of the checks in this case, with the commit it ran on. */
  private readonly checkRuns: CheckRun[] = []
  /** Whether the checks the case failed fail on its base too, as `Run` asks it. */
  private readonly baseProbe = new BaseProbe()
  /** What the tests of each head proved, once per head, as `Run.provesTests` keeps it (#550). */
  private readonly proofs = new Map<string, TestProof>()
  private readonly started = Date.now()
  private readonly securitySeen = new Set<string>()
  private securityReworks = 0
  private securityEarlier: Finding[] = []
  /** What the deterministic floor blocked in any round: a case written to be blocked passes on it. */
  private readonly floorFound: string[] = []

  constructor(
    private readonly deps: EvalDeps,
    private readonly c: EvalCase,
    private readonly sandbox: IsolatedSandbox,
    private readonly repoDir: string,
    private readonly knowledgeDir: string | undefined,
    private readonly signal?: AbortSignal,
  ) {}

  /**
   * Every agent call goes through here. An abandoned case starts none, and a call that answers after the case
   * was abandoned ends it, so nothing after it runs against the stopped sandbox.
   */
  private async agentCall(start: () => Promise<HarnessResult>): Promise<HarnessResult> {
    ensureLive(this.signal)
    const result = await start()
    ensureLive(this.signal)
    return result
  }

  private get backend(): SandboxBackend {
    return this.sandbox.backend
  }
  private get git() {
    return `GIT_CONFIG_GLOBAL=${GITCONFIG} git -c core.hooksPath=/dev/null -C ${this.repoDir}`
  }
  private get limits() {
    return fitToSession(this.deps.timeouts ?? DEFAULT_TIMEOUTS, this.deps.sandbox.maxSessionMs)
  }

  /** Books what an agent pass cost and turns one that did not finish into the end of the case. */
  private settle(result: HarnessResult, what: string): HarnessResult {
    this.cost += result.costUsd ?? 0
    this.sessionId = result.sessionId ?? this.sessionId
    if (!result.ok) throw new Stopped(`${what}: ${oneLine(result.summary).slice(0, 300)}`)
    return result
  }

  private agentInput(prompt: string, longest = Infinity, role?: CodingRole): HarnessInput {
    return {
      ...(role ? { role } : {}),
      cwd: this.repoDir,
      prompt,
      timeoutMs: Math.min(agentTimeLeft(this.limits, Date.now() - this.started), longest),
    }
  }

  private buildInput(): Parameters<typeof buildPrompt>[0] {
    const { c } = this
    return {
      repo: c.repository,
      issueNumber: c.issueNumber,
      title: c.title,
      body: c.body,
      branch: `factory/${c.issueNumber}`,
      askQuestions: false,
      knowledgeDir: this.knowledgeDir,
      checks: c.checks,
      installFailed: failedInstall(this.installed),
    }
  }

  /** The install before the builder's first pass, as `Run.installProject` keeps it. */
  private installed: PreparedInstall | undefined

  /**
   * The builder's work, as `Run.build` does it: a builder that can continue a session first writes a plan
   * (`Run.planChange`), what the planning turn changed is thrown away, and the work continues that session.
   */
  async build(): Promise<void> {
    const { builder, planner } = this.deps
    this.installed = await prepareInstall(
      this.backend,
      this.repoDir,
      this.c.checks,
      this.limits.checkMs ?? DEFAULT_CHECK_MS,
    )
    const apart = planner !== undefined && planner.name !== builder.name
    const discarded =
      apart || builder.resume ? await this.planChange(apart ? planner : builder) : undefined
    const result = await this.agentCall(() => {
      if (apart && this.plan) {
        const prompt = givenPlanPrompt(this.buildInput(), this.plan, planner.name)
        return builder.run(this.backend, this.agentInput(prompt, Infinity, 'builder'))
      }
      return discarded === undefined
        ? builder.run(this.backend, this.agentInput(buildPrompt(this.buildInput()), Infinity, 'builder'))
        : builder.resume!(
            this.backend,
            this.sessionId!,
            this.agentInput(implementPlanPrompt({ discarded }), Infinity, 'builder'),
          )
    })
    this.settle(result, 'the agent did not finish')
    this.summary = result.summary
    if (parseQuestion(result.summary)) throw new Stopped('the agent asked a question')
  }

  /** Writes the plan and answers whether the planning turn left edits, which are thrown away. */
  private async planChange(planner: CodingHarness): Promise<boolean> {
    const input = this.agentInput(changePlanPrompt(this.buildInput()), PLAN_MS, 'planner')
    const first = this.settle(
      await this.agentCall(() => planner.run(this.backend, input)),
      'the agent did not finish the plan',
    )
    this.plan = parseNewChangePlan(first.summary) ?? (await this.planAgain(planner, input.timeoutMs))
    const pending = await must(this.backend, `git -C ${this.repoDir} status --porcelain`)
    if (pending.stdout.trim() === '') return false
    await must(this.backend, `git -C ${this.repoDir} reset --hard ${this.c.baseSha}`)
    await must(this.backend, `git -C ${this.repoDir} clean -fd`)
    return true
  }

  /** The planning turn ended with no plan that could be read: one more turn, asking for the plan alone. */
  private async planAgain(planner: CodingHarness, timeoutMs: number): Promise<ChangePlan> {
    if (!planner.resume || !this.sessionId) throw new Stopped('the agent wrote no plan')
    const again = await this.agentCall(() =>
      planner.resume!(this.backend, this.sessionId!, {
        cwd: this.repoDir,
        timeoutMs,
        prompt: planAgainPrompt(),
        role: 'planner',
      }),
    )
    this.cost += again.costUsd ?? 0
    this.sessionId = again.sessionId ?? this.sessionId
    const plan = again.ok ? parseNewChangePlan(again.summary) : undefined
    if (!plan) throw new Stopped(`the agent wrote no plan: ${oneLine(again.summary).slice(0, 300)}`)
    return plan
  }

  /**
   * The last rework broke the checks and no attempt is left: the reviewed commit's tree comes back as a new
   * commit and the checks run on it, as `Run.restoreReviewed` does (#216). The case ends as it would have there,
   * or on the checks when they fail on it too.
   */
  private async restoreReviewed(
    kept: { sha: string; end: CaseEnd },
    failed: CheckResult[],
  ): Promise<CaseEnd> {
    await must(
      this.backend,
      `git -C ${this.repoDir} restore --source=${kept.sha} --staged --worktree :/`,
    )
    if (!(await this.hasChange())) return checksFailed(failed)
    await this.commitAll(`evaluation of ${this.c.id}, ${kept.sha.slice(0, 7)} restored`)
    this.committed = (await must(this.backend, `${this.git} rev-parse HEAD`)).stdout.trim()
    const again = await this.check(this.committed)
    return again.length > 0 ? checksFailed(again) : kept.end
  }

  /** Sends the work back to the builder, as `Run.rework`. Answers whether the builder changed anything. */
  private async rework(
    findings: Finding[],
    failed: CheckResult[],
    reviewedSha?: string,
  ): Promise<boolean> {
    this.attempts++
    const prompt = reworkPrompt({
      findings,
      failedChecks: failed,
      checks: this.c.checks,
      ...(reviewedSha ? { reviewedSha, changeBase: this.c.baseSha } : {}),
    })
    const result = await this.agentCall(() =>
      this.deps.builder.resume!(this.backend, this.sessionId!, this.agentInput(prompt, Infinity, 'builder')),
    )
    this.settle(result, 'the agent did not finish the rework')
    this.summary = result.summary
    if (findings.length > 0) this.reviewAnswer = result.summary
    return this.hasChange()
  }

  /** Whether the checkout holds something past the last commit of the case: a file left or a commit made. */
  private async hasChange(): Promise<boolean> {
    const changes = await must(this.backend, `git -C ${this.repoDir} status --porcelain`)
    if (changes.stdout.trim() !== '') return true
    const since = this.committed ?? this.c.baseSha
    const ahead = await must(this.backend, `git -C ${this.repoDir} rev-list --count ${since}..HEAD`)
    return Number(ahead.stdout.trim()) > 0
  }

  /**
   * Commits what the builder left, in the sandbox only, and answers the commit. A commit the builder made by
   * itself (a merge does) counts as its change and goes as it is, the same as `Run.commitAndPush`.
   */
  private async commit(): Promise<string> {
    if (!(await this.hasChange())) {
      // As `Run.resolvedAlready`: on the first pass, fixes that change the starting commit make the change.
      const fixed = this.committed === undefined ? await this.applyFixes(this.c.baseSha) : undefined
      if (fixed && fixed !== this.c.baseSha) return fixed
      throw new Stopped('the agent made no change')
    }
    const changes = await must(this.backend, `git -C ${this.repoDir} status --porcelain`)
    if (changes.stdout.trim() !== '')
      await this.commitAll(`evaluation of ${this.c.id}, attempt ${this.attempts}`)
    this.committed = (await must(this.backend, `${this.git} rev-parse HEAD`)).stdout.trim()
    return this.committed
  }

  /** Commits everything in the checkout, in the sandbox only. The message goes in by file. */
  private async commitAll(message: string): Promise<void> {
    await this.backend.uploadFile(GITCONFIG, gitConfig(this.deps.author))
    await this.backend.uploadFile(COMMIT_MESSAGE, `${message}\n`)
    await must(this.backend, `${this.git} add -A`)
    await must(this.backend, `${this.git} commit -F ${COMMIT_MESSAGE}`)
  }

  /** The repository's fix commands, then their change as its own commit in the sandbox, as `Run.applyFixes`. */
  private async applyFixes(sha: string): Promise<string> {
    const fixes = this.c.fixes ?? []
    if (fixes.length === 0 || sha === this.fixedHead) return sha
    const { changed } = await runFixes(
      this.backend,
      this.repoDir,
      fixes,
      this.limits.checkMs ?? DEFAULT_CHECK_MS,
    )
    this.fixedHead = sha
    if (!changed) return sha
    await this.commitAll(FIX_COMMIT_MESSAGE)
    this.committed = (await must(this.backend, `${this.git} rev-parse HEAD`)).stdout.trim()
    this.fixedHead = this.committed
    return this.committed
  }

  /** The end of a case whose failing checks fail on its base too, or nothing when any passes there. */
  private async failingOnBase(failed: CheckResult[]): Promise<CaseEnd | undefined> {
    const red = await this.baseProbe.red(
      this.backend,
      {
        repoDir: this.repoDir,
        baseSha: this.c.baseSha,
        checks: this.c.checks,
        timeoutMs: this.limits.checkMs ?? DEFAULT_CHECK_MS,
      },
      failed,
    )
    if (!red) return undefined
    const names = red.map((name) => `"${name}"`).join(', ')
    return {
      stopped: `${names} failed on the case's base ${this.c.baseSha.slice(0, 7)} too, ${MEASURED_ITS_BASE}`,
    }
  }

  /**
   * The review, with the finding `Run.review` adds in `auto` when the tests this commit adds pass on the base
   * (#550): the verdict cannot be `approve`, and the finding reaches the rework. The step runs once per head.
   */
  private async reviewedWithProof(
    sha: string,
    unplanned: string[],
    required: Parameters<CaseRun['review']>[2],
  ): Promise<ReviewVerdict> {
    const mode = testProofModeFromEnv(process.env)
    const proof = await provedOnce(
      { mode, sha, known: this.proofs, store: { load: async () => undefined, save: async () => {} } },
      () =>
        proveTests(this.backend, {
          repoDir: this.repoDir,
          baseSha: this.c.baseSha,
          headSha: sha,
          checks: this.c.checks,
          timeoutMs: this.limits.checkMs ?? DEFAULT_CHECK_MS,
        }),
    )
    const proved = addsProofFinding(mode, proof)
    const read = await this.review(sha, unplanned, required)
    if (proved.length === 0) return read
    return {
      ...read,
      verdict: blockedByProof(read.verdict, proved),
      findings: [...proved, ...read.findings],
    }
  }

  /** Runs the checks on the commit and keeps every result, as the factory keeps its evidence. */
  private async check(sha: string): Promise<CheckResult[]> {
    await must(this.backend, `git -C ${this.repoDir} clean -fdxq`)
    await uploadChangesetCheck(this.backend, this.c.checks)
    const results = await runChecks(
      this.backend,
      this.repoDir,
      this.c.checks,
      this.limits.checkMs ?? DEFAULT_CHECK_MS,
    )
    this.checkRuns.push(...results.map((result) => ({ ...result, sha })))
    return failingChecks(results)
  }

  private risk: RiskAssessment | undefined

  private async review(
    sha: string,
    unplanned: string[],
    required: RequiredByCheck[],
  ): Promise<ReviewVerdict> {
    this.reviewRounds++
    const { c } = this
    const input: HarnessInput = {
      cwd: this.repoDir,
      timeoutMs: this.limits.reviewMs ?? DEFAULT_REVIEW_MS,
      role: 'reviewer',
      prompt: reviewPrompt({
        repo: c.repository,
        issueNumber: c.issueNumber,
        title: c.title,
        body: c.body,
        branch: `factory/${c.issueNumber}`,
        baseSha: c.baseSha,
        knowledgeDir: this.knowledgeDir,
        required,
        ...(this.risk ? { risk: this.risk } : {}),
        ...(this.earlier ? { earlier: this.earlier } : {}),
        builderSummary: this.reviewAnswer ?? this.summary,
        ...(this.plan
          ? {
              plan: renderChangePlan(this.plan),
              unplanned,
              acceptance: this.plan.acceptance ?? [],
            }
          : {}),
      }),
    }
    const result = await this.agentCall(() => this.deps.reviewer.run(this.backend, input))
    this.cost += result.costUsd ?? 0
    this.reviewerCost += result.costUsd ?? 0
    // The reviewer reads and does not write; whatever it wrote anyway is thrown away.
    await must(this.backend, `${this.git} reset --hard ${sha}`)
    await must(this.backend, `${this.git} clean -fd`)
    const verdict: ReviewVerdict = result.ok
      ? withAcceptance(parseVerdict(result.summary), this.plan?.acceptance, result.summary)
      : { verdict: 'invalid', summary: result.summary, findings: [] }
    this.reviews.push(verdict)
    return verdict
  }

  /**
   * The security review after an approval, as `Run.secured`: the floor on the commit, then the agent, read-only.
   * A first block sends the builder back; a floor finding, a repeated finding or an unusable answer blocks.
   */
  private async secure(sha: string): Promise<'pass' | 'rework' | { blocked: string[] }> {
    const { security } = this.deps
    if (security === undefined) return 'pass'
    const floor = await securityFloor(this.backend, this.repoDir, this.c.baseSha)
    let verdict: ReviewVerdict
    let skipped: string | undefined
    if (floor.some((f) => f.severity !== 'minor')) {
      verdict = { verdict: 'changes', summary: 'the deterministic floor blocks it', findings: [] }
    } else if (
      (skipped = skippedBecause(
        await securitySurfacesOf(this.backend, this.repoDir, this.c.baseSha),
      ))
    ) {
      verdict = { verdict: 'approve', summary: skipped, findings: [] }
    } else if (security === null) {
      verdict = {
        verdict: 'invalid',
        summary: 'no security agent could start: its highest effort is not known',
        findings: [],
      }
    } else {
      const diff = await securityDiff(this.backend, this.repoDir, this.c.baseSha)
      const result = await this.agentCall(() =>
        security.run(this.backend, {
          cwd: this.repoDir,
          timeoutMs: this.limits.reviewMs ?? DEFAULT_REVIEW_MS,
          prompt: securityPrompt({
            repo: this.c.repository,
            issueNumber: this.c.issueNumber,
            title: this.c.title,
            body: this.c.body,
            baseSha: this.c.baseSha,
            diff,
            knowledgeDir: this.knowledgeDir,
            earlier: this.securityEarlier,
          }),
        }),
      )
      this.cost += result.costUsd ?? 0
      this.securityCost += result.costUsd ?? 0
      // The security agent reads and does not write; whatever it wrote anyway is thrown away.
      await must(this.backend, `${this.git} reset --hard ${sha}`)
      await must(this.backend, `${this.git} clean -fdx -e node_modules`)
      verdict = result.ok
        ? parseSecurityVerdict(result.summary)
        : { verdict: 'invalid', summary: result.summary, findings: [] }
    }
    const decision = decideSecurity({
      floor,
      verdict,
      seen: this.securitySeen,
      reworks: this.securityReworks,
      canRework: this.canResume(),
    })
    if (decision.kind === 'pass') return 'pass'
    const findings = [...floor, ...verdict.findings]
    for (const f of findings.filter((x) => x.severity !== 'minor')) this.securitySeen.add(findingKey(f))
    this.securityEarlier = findings
    if (decision.kind === 'rework') {
      this.securityReworks++
      if (await this.rework(decision.findings, [], sha)) return 'rework'
      return { blocked: ['the builder changed nothing in answer to the security review'] }
    }
    return { blocked: [decision.reason, ...findings.map((f) => f.issue)] }
  }

  /**
   * What follows an approval, as `Run.approved` does it: the security review, then the lenses, then the integration
   * gate. `'again'` is a send-back that changed the work, which the loop checks and reviews.
   */
  private async afterApproval(sha: string): Promise<CaseEnd | 'again'> {
    const secured = await this.secure(sha)
    if (typeof secured === 'object') return this.securityEnd(secured.blocked)
    if (secured === 'rework') return 'again'
    if ((await this.lens(sha)) === 'rework') return 'again'
    return (
      (await this.integrationGate(sha)) ?? {
        checksPassed: true,
        verdict: 'approve',
        blockingGuards: [],
      }
    )
  }

  /**
   * The lenses over approved work, as `Run.lensed`: read-only, the reviewer's agent in a fresh session. In `auto` a
   * blocking finding sends the builder back once; an answer that does not parse, or a lens that cannot run, is
   * recorded as such and the case goes on. A lens never ends a case.
   */
  private async lens(sha: string): Promise<'pass' | 'rework'> {
    const mode = lensModeFromEnv(process.env)
    if (mode === 'off') return 'pass'
    for (const lens of LENSES) {
      let verdict: ReviewVerdict
      try {
        const documents = await documentPaths(this.backend, this.repoDir)
        if (documents.length === 0) continue
        const diff = await securityDiff(this.backend, this.repoDir, this.c.baseSha)
        const result = await this.agentCall(() =>
          this.deps.reviewer.run(this.backend, {
            cwd: this.repoDir,
            timeoutMs: this.limits.reviewMs ?? DEFAULT_REVIEW_MS,
            role: 'reviewer',
            prompt: lens.prompt({
              repo: this.c.repository,
              issueNumber: this.c.issueNumber,
              title: this.c.title,
              body: this.c.body,
              baseSha: this.c.baseSha,
              diff,
              documents,
              knowledgeDir: this.knowledgeDir,
              earlier: this.lensEarlier,
            }),
          }),
        )
        this.cost += result.costUsd ?? 0
        this.lensCost += result.costUsd ?? 0
        await must(this.backend, `${this.git} reset --hard ${sha}`)
        await must(this.backend, `${this.git} clean -fdx -e node_modules`)
        verdict = result.ok
          ? parseLensVerdict(result.summary)
          : { verdict: 'invalid', summary: result.summary, findings: [] }
      } catch (error) {
        if (error instanceof Stopped) throw error
        verdict = { verdict: 'invalid', summary: String(error), findings: [] }
      }
      const decision = decideLens({
        mode,
        verdict,
        reworks: this.lensReworks,
        canRework: this.canResume(),
      })
      this.lensEarlier = verdict.findings
      if (decision.kind === 'rework') {
        this.lensReworks++
        if (await this.rework(decision.findings, [], sha)) return 'rework'
      }
    }
    return 'pass'
  }

  /** How a case ends once the security review blocked an approved change. */
  private securityEnd(blocked: string[]): CaseEnd {
    return { checksPassed: true, verdict: 'approve', blockingGuards: [], securityBlocked: blocked }
  }

  private canResume(): boolean {
    return this.deps.builder.resume !== undefined && !!this.sessionId
  }

  /** Failing checks send the builder back up to `MAX_CHECK_REWORKS` times, as `Run.loop`; a review has its own rule. */
  private canRework(): boolean {
    return this.checkReworks < MAX_CHECK_REWORKS && this.canResume()
  }

  /**
   * As `Run.mergedBeforeIntegration` does for approved work: the repository's integration checks run on the
   * approved commit. A case runs on its own base, which nothing moves, so there is never a merge to make here.
   * Answers the end of a case whose integration checks failed, as the factory fails the run.
   */
  private async integrationGate(sha: string): Promise<CaseEnd | undefined> {
    const checks = this.c.integrationChecks ?? []
    if (checks.length === 0) return undefined
    const results = await runChecks(
      this.backend,
      this.repoDir,
      checks,
      this.limits.checkMs ?? DEFAULT_CHECK_MS,
    )
    this.checkRuns.push(...results.map((result) => ({ ...result, sha })))
    const failed = failingChecks(results)
    return failed.length > 0 ? checksFailed(failed) : undefined
  }

  /** Checks, reviews and reworks until the case is approved or out of attempts, as `Run.loop` does. */
  async loop(): Promise<CaseEnd> {
    let sha = await this.applyFixes(await this.commit())
    // The last reviewed commit whose checks passed, and how the case would end there, as `Run.loop` keeps it.
    let reviewed: { sha: string; end: CaseEnd } | undefined
    // The checks that failed on the commit before, while they keep failing.
    let failedBefore: CheckResult[] | undefined
    for (;;) {
      const failed = await this.check(sha)
      if (failed.length > 0) {
        // The same checks failed on the commit before, as `Run.loop` asks (#219).
        const red = sameChecks(failedBefore, failed) ? await this.failingOnBase(failed) : undefined
        if (red) return red
        failedBefore = failed
        if (!this.canRework()) {
          return reviewed ? this.restoreReviewed(reviewed, failed) : checksFailed(failed)
        }
        // A rework that changed nothing has the checks run again on the same commit (#214), unless they fail on
        // the case's base too, as `Run.refuseRedBase` asks (#219).
        this.checkReworks++
        if (await this.rework([], failed)) sha = await this.applyFixes(await this.commit())
        else {
          const red = await this.failingOnBase(failed)
          if (red) return red
        }
        continue
      }
      failedBefore = undefined
      const { guards, unplanned, required, touched, size } = await diffFacts(this.backend, this.repoDir, {
        baseSha: this.c.baseSha,
        plan: this.plan,
        issue: { labels: this.c.labels, title: this.c.title, body: this.c.body },
        checkRuns: this.checkRuns,
      })
      // The same rating `Run.review` gives the commit, so the reviewer reads what it reads in the factory (#470).
      this.risk = assessmentFor(
        sha,
        assessRisk({
          paths: touched,
          lines: size.added + size.removed,
          files: size.files,
          labels: this.c.labels,
          unplanned,
        }),
      )
      const blocking = guards.filter((g) => g.severity !== 'minor')
      if (blocking.length > 0 && this.c.expectSecurity === 'block') {
        const floor = await securityFloor(this.backend, this.repoDir, this.c.baseSha)
        for (const f of floor) if (!this.floorFound.includes(f.issue)) this.floorFound.push(f.issue)
      }
      const read = await this.reviewedWithProof(sha, unplanned, required)
      // Any valid verdict counts, even when the case ends later without one.
      if (read.verdict !== 'invalid') this.verdictSeen = true
      // A file outside the plan is on record; whether it was needed is the reviewer's call.
      const outside: Finding[] = unplanned.map((file) => ({
        severity: 'minor',
        file,
        issue: OUTSIDE_THE_PLAN,
      }))
      // The same findings `Run.review` stores, so the rounds are counted as the factory counts them.
      this.blockingCounts.push(blockingCount([...guards, ...outside, ...read.findings]))
      if (read.verdict === 'approve' && blocking.length === 0) {
        const end = await this.afterApproval(sha)
        if (end !== 'again') return end
        sha = await this.applyFixes(await this.commit())
        continue
      }
      // What the factory hands over: green checks and a review that did not approve.
      const handedOver: CaseEnd = {
        checksPassed: true,
        verdict: read.verdict,
        blockingGuards: blocking.map((g) => g.issue),
      }
      reviewed = { sha, end: handedOver }
      if (
        read.verdict === 'invalid' ||
        !this.canResume() ||
        !reviewAllowsRework(this.blockingCounts.length, this.blockingCounts)
      ) {
        return handedOver
      }
      const findings = [...guards, ...outside, ...read.findings]
      // The next round starts from these findings, as `Run.review` keeps them.
      this.earlier = { sha, findings }
      // A rework that changed nothing has the reviewer judge the builder's reasons on the same commit, once, as
      // `Run.arbitrate` does; a review that still blocks ends the case as the factory hands it over.
      if (!(await this.rework(findings, [], sha))) {
        const judged = await this.reviewedWithProof(sha, unplanned, required)
        if (judged.verdict === 'approve' && blocking.length === 0) {
          const end = await this.afterApproval(sha)
          if (end !== 'again') return end
          sha = await this.applyFixes(await this.commit())
          continue
        }
        return judged.verdict === 'invalid' ? handedOver : { ...handedOver, verdict: judged.verdict }
      }
      sha = await this.applyFixes(await this.commit())
    }
  }

  /** A case written to be blocked also counts what the floor stopped before the security agent could read it. */
  private withFloor(end: CaseEnd): CaseEnd {
    if (this.c.expectSecurity !== 'block' || 'stopped' in end || this.floorFound.length === 0) {
      return end
    }
    return { ...end, securityBlocked: [...(end.securityBlocked ?? []), ...this.floorFound] }
  }

  result(end: CaseEnd): CaseResult {
    return {
      id: this.c.id,
      ...caseOutcome(this.withFloor(end), this.c.expectSecurity),
      costUsd: this.cost,
      costByRole: {
        builder: Math.max(0, this.cost - this.reviewerCost - this.securityCost - this.lensCost),
        reviewer: this.reviewerCost,
        security: this.securityCost,
        lens: this.lensCost,
      },
      durationMs: Date.now() - this.started,
      attempts: this.attempts,
      reviewRounds: this.reviewRounds,
      reachedVerdict: this.verdictSeen,
      reviews: this.reviews,
    }
  }
}

const names = (checks: CheckResult[]) => [...new Set(checks.map((c) => c.name))]

/** How a case ends when its checks failed on the last commit it had. */
const checksFailed = (failed: CheckResult[]): CaseEnd => ({
  checksPassed: false,
  verdict: 'invalid',
  blockingGuards: [],
  failedChecks: names(failed),
})

/** Names this process's evaluation runs; the sandbox's metadata also carries the process, which says whether it lives. */
const PROCESS_RUN = randomUUID()

/** The agents a case runs, each once by name: the builder, the reviewer and a planner apart from them (run.ts). */
function caseAgents(deps: EvalDeps): CodingHarness[] {
  const byName = new Map<string, CodingHarness>()
  for (const agent of [deps.builder, deps.reviewer, deps.planner, deps.security]) {
    if (agent && !byName.has(agent.name)) byName.set(agent.name, agent)
  }
  return [...byName.values()]
}

/** What the sandbox of a case may reach: GitHub without a credential, the agents, the registry. */
async function specFor(deps: EvalDeps, c: EvalCase): Promise<SandboxSpec> {
  const agents = caseAgents(deps)
  const agentEgress = (await Promise.all(agents.map((a) => a.egress()))).flat()
  return {
    owner: { owner: 'eval', caseId: c.id, runId: PROCESS_RUN },
    timeoutMs: fitToSession(deps.timeouts ?? DEFAULT_TIMEOUTS, deps.sandbox.maxSessionMs).sandboxMs,
    cacheKey: c.repository,
    egress: [
      { domain: 'github.com' },
      ...agentEgress,
      { domain: 'registry.npmjs.org' },
      ...c.egress.map((domain) => ({ domain })),
    ],
  }
}

/** Puts the clone on the case's base commit, on the branch the task had. */
async function checkout(backend: SandboxBackend, c: EvalCase): Promise<string> {
  const { repoDir } = await cloneRepository(backend, {
    repoUrl: `https://github.com/${c.repository}.git`,
    ref: c.integrationBranch,
    instanceId: INSTANCE,
  })
  await must(backend, `git -C ${repoDir} fetch origin ${c.baseSha}`)
  await must(backend, `git -C ${repoDir} checkout -B factory/${c.issueNumber} ${c.baseSha}`)
  await prepareDeclaredPackageManager(backend, repoDir)
  return repoDir
}

/** Runs one case and answers what it came to; it fails the case, never the suite, on what goes wrong. */
export async function runCase(
  deps: EvalDeps,
  c: EvalCase,
  signal?: AbortSignal,
): Promise<CaseResult> {
  const started = Date.now()
  // The case's run once it exists, so a case stopped later still reports the reviews it completed.
  const held: { sandbox?: IsolatedSandbox; run?: CaseRun } = {}
  const stoppedAs = (reason: string): CaseResult => ({
    id: c.id,
    ...caseOutcome({ stopped: reason }),
    costUsd: 0,
    durationMs: Date.now() - started,
    attempts: 0,
    reviewRounds: 0,
    reachedVerdict: false,
    reviews: held.run ? [...held.run.reviews] : [],
  })
  // The hash reaches a shell, so only a full commit hash gets that far.
  if (!COMMIT.test(c.baseSha))
    return stoppedAs(`the base ${JSON.stringify(c.baseSha)} is not a commit hash`)

  // Checked before each step of the setup; inside the run, every agent call checks it too.
  const live = () => ensureLive(signal)
  if (signal?.aborted) return stoppedAs(ABANDONED)

  let stopped = false
  const stopSandbox = async () => {
    if (stopped || !held.sandbox) return
    stopped = true
    await held.sandbox.stop().catch(() => {})
  }
  // An abandoned case stops its sandbox at once, so work that hangs cannot go on costing, and ends as stopped.
  let onAbort = () => {}
  const abandoned = new Promise<CaseResult>((resolve) => {
    onAbort = () => {
      void stopSandbox()
      resolve(stoppedAs(ABANDONED))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  const work = async (): Promise<CaseResult> => {
    const spec = await specFor(deps, c)
    live()
    // The factory's runs may hold every sandbox the provider allows; the case waits for one to free (#261).
    let sandbox = await whenSlotFree(() => createIsolatedSandbox(deps.sandbox, spec), { signal })
    held.sandbox = sandbox
    // Abandoned while it was being created: the abort handler and `finally` found nothing to stop.
    if (signal?.aborted) await stopSandbox()
    live()
    const repoDir = await checkout(sandbox.backend, c)
    live()
    for (const agent of caseAgents(deps)) {
      await agent.prepare?.(sandbox.backend)
      live()
    }
    const feed = await KnowledgeFeed.open(deps.knowledge, sandbox.backend, c.repository, {})
    sandbox = feed.attachTo(sandbox)
    held.sandbox = sandbox
    live()
    const run = new CaseRun(deps, c, sandbox, repoDir, feed.dir, signal)
    held.run = run
    // Before the builder's first pass, so it can run the check it is told to run.
    await uploadChangesetCheck(sandbox.backend, c.checks)
    live()
    try {
      await run.build()
      return run.result(await run.loop())
    } catch (error) {
      if (!(error instanceof Stopped || error instanceof NoTimeForAgent)) throw error
      return run.result({ stopped: error.message })
    }
  }
  try {
    return await Promise.race([work(), abandoned])
  } catch (error) {
    return stoppedAs(error instanceof Error ? error.message : String(error))
  } finally {
    signal?.removeEventListener('abort', onAbort)
    await stopSandbox()
  }
}

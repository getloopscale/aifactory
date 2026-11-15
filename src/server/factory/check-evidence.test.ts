import { describe, expect, it } from 'vitest'

import type { FailedRun } from '../github/promotion-api'
import type { CheckReport } from '../github/pulls'

import {
  attachEvidence,
  readEvidence,
  rerunTransient,
  type EvidenceApi,
  type RerunLedger,
} from './check-evidence'

const SHA = 'abc1234def'
const REPO = 'o/r'

const actionsRun = (over: Partial<FailedRun> = {}): FailedRun => ({
  id: 11,
  name: 'CI',
  url: 'https://github.com/o/r/actions/runs/1/job/11',
  summary: '',
  actions: true,
  ...over,
})
const report = (name: string, detail = ''): CheckReport => ({
  name,
  state: 'failure',
  detail,
  url: `https://github.com/o/r/runs/${name}`,
})

const DOC_LOG = [
  '2026-11-12T10:00:00.0000000Z > npm run docs:coverage',
  '2026-11-12T10:00:01.0000000Z [doc-coverage] FAIL 99.7% is below the 100% floor',
  '2026-11-12T10:00:02.0000000Z ##[error]Process completed with exit code 1.',
].join('\n')

/** The log of an aggregate job (shared-workflows `checks-pass`), which names no failure of its own. */
const AGGREGATE_LOG = [
  '2026-11-12T22:00:00.0000000Z Run re-actors/alls-green@release/v1',
  '2026-11-12T22:00:01.0000000Z ##[error]at least one dependency did not succeed',
].join('\n')
const TYPE_TESTS_LOG = [
  '2026-11-12T21:58:00.0000000Z > vitest --typecheck',
  '2026-11-12T21:58:01.0000000Z AssertionError: expected 1 to be 2',
  '2026-11-12T21:58:02.0000000Z ##[error]Process completed with exit code 1.',
].join('\n')

/** GitHub as the evidence reader sees it: the failed runs of a commit, their logs and annotations. */
function fakeApi(
  options: {
    runs?: FailedRun[]
    logs?: Record<number, string>
    annotations?: Record<number, string[]>
    failChecks?: boolean
    failLogOf?: number
  } = {},
) {
  const calls: string[] = []
  const api: EvidenceApi = {
    failedChecks: async (repo, token, sha) => {
      calls.push(`checks ${repo} ${token} ${sha}`)
      if (options.failChecks) throw new Error('GitHub answered 502 reading the check runs')
      return options.runs ?? []
    },
    jobLog: async (repo, token, jobId) => {
      calls.push(`log ${repo} ${token} ${jobId}`)
      if (options.failLogOf === jobId) throw new Error(`GitHub answered 410 reading job ${jobId}`)
      return options.logs?.[jobId] ?? ''
    },
    annotations: async (repo, token, checkRunId) => {
      calls.push(`annotations ${repo} ${token} ${checkRunId}`)
      return options.annotations?.[checkRunId] ?? []
    },
  }
  return { api, calls }
}

describe('readEvidence', () => {
  it('reads the error lines of an Actions job from its log', async () => {
    const { api, calls } = fakeApi({ logs: { 11: DOC_LOG } })

    const lines = await readEvidence(api, REPO, 't', actionsRun())

    expect(lines).toEqual(['[doc-coverage] FAIL 99.7% is below the 100% floor'])
    expect(calls).toEqual(['log o/r t 11'])
  })

  it('reads the annotations and summary of a check that is not an Actions job', async () => {
    const { api, calls } = fakeApi({ annotations: { 21: ['src/a.ts:3 Sink: tainted input'] } })

    const lines = await readEvidence(
      api,
      REPO,
      't',
      actionsRun({ id: 21, name: 'CodeQL', actions: false, summary: '1 new alert' }),
    )

    expect(lines).toEqual(['src/a.ts:3 Sink: tainted input', '1 new alert'])
    expect(calls).toEqual(['annotations o/r t 21'])
  })
})

describe('attachEvidence', () => {
  it('gives each failed check the evidence of the check run with its name', async () => {
    const { api, calls } = fakeApi({
      runs: [actionsRun({ id: 9, name: 'Lint' }), actionsRun()],
      logs: { 11: DOC_LOG, 9: 'error TS2322: wrong type' },
    })

    const failed = await attachEvidence(api, REPO, 't', SHA, [report('CI', 'summary')])

    expect(failed).toEqual([
      {
        ...report('CI', 'summary'),
        evidence: { lines: ['[doc-coverage] FAIL 99.7% is below the 100% floor'] },
      },
    ])
    expect(calls).toEqual([`checks o/r t ${SHA}`, 'log o/r t 11'])
  })

  it('adds the failed jobs a required aggregate check only says did not succeed', async () => {
    const { api } = fakeApi({
      runs: [
        actionsRun({ id: 1, name: 'CI' }),
        actionsRun({ id: 2, name: 'Type tests', url: 'https://ci/2' }),
      ],
      logs: { 1: AGGREGATE_LOG, 2: TYPE_TESTS_LOG },
    })

    const failed = await attachEvidence(api, REPO, 't', SHA, [report('CI')])

    expect(failed).toEqual([
      { ...report('CI'), evidence: { lines: [] } },
      {
        name: 'Type tests',
        state: 'failure',
        detail: '',
        url: 'https://ci/2',
        notRequired: true,
        evidence: { lines: ['AssertionError: expected 1 to be 2'] },
      },
    ])
  })

  it('adds the other failed jobs once, when only one of the required checks is an aggregate', async () => {
    const { api } = fakeApi({
      runs: [
        actionsRun({ id: 1, name: 'CI' }),
        actionsRun({ id: 9, name: 'Lint' }),
        actionsRun({ id: 2, name: 'Type tests' }),
      ],
      logs: { 1: AGGREGATE_LOG, 9: 'error TS2322: wrong type', 2: TYPE_TESTS_LOG },
    })

    const failed = await attachEvidence(api, REPO, 't', SHA, [report('CI'), report('Lint')])

    expect(failed.map((r) => [r.name, r.notRequired ?? false])).toEqual([
      ['CI', false],
      ['Lint', false],
      ['Type tests', true],
    ])
  })

  it('leaves out another failed job that says no more than the aggregate does', async () => {
    const { api } = fakeApi({
      runs: [actionsRun({ id: 1, name: 'CI' }), actionsRun({ id: 3, name: 'All checks' })],
      logs: { 1: AGGREGATE_LOG, 3: AGGREGATE_LOG },
    })

    expect(await attachEvidence(api, REPO, 't', SHA, [report('CI')])).toEqual([
      { ...report('CI'), evidence: { lines: [] } },
    ])
  })

  it('names another failed job whose evidence could not be read', async () => {
    const { api } = fakeApi({
      runs: [actionsRun({ id: 1, name: 'CI' }), actionsRun({ id: 4, name: 'Type tests' })],
      logs: { 1: AGGREGATE_LOG },
      failLogOf: 4,
    })

    const failed = await attachEvidence(api, REPO, 't', SHA, [report('CI')])

    expect(failed[1]).toMatchObject({
      name: 'Type tests',
      notRequired: true,
      evidence: { unreadable: 'GitHub answered 410 reading job 4' },
    })
  })

  it('does not look past a required check whose evidence could not be read', async () => {
    const { api, calls } = fakeApi({
      runs: [actionsRun({ id: 1, name: 'CI' }), actionsRun({ id: 2, name: 'Type tests' })],
      logs: { 2: TYPE_TESTS_LOG },
      failLogOf: 1,
    })

    const failed = await attachEvidence(api, REPO, 't', SHA, [report('CI')])

    expect(failed).toEqual([
      { ...report('CI'), evidence: { unreadable: 'GitHub answered 410 reading job 1' } },
    ])
    expect(calls).toEqual([`checks o/r t ${SHA}`, 'log o/r t 1'])
  })

  it('leaves a commit status, which has no check run, with what it said of itself', async () => {
    const { api } = fakeApi({ runs: [] })

    expect(
      await attachEvidence(api, REPO, 't', SHA, [report('ci/jenkins', 'build broke')]),
    ).toEqual([report('ci/jenkins', 'build broke')])
  })

  it('says why the evidence of one check could not be read, and reads the others', async () => {
    const { api } = fakeApi({
      runs: [actionsRun(), actionsRun({ id: 12, name: 'Docs' })],
      logs: { 12: DOC_LOG },
      failLogOf: 11,
    })

    const failed = await attachEvidence(api, REPO, 't', SHA, [report('CI'), report('Docs')])

    expect(failed).toEqual([
      { ...report('CI'), evidence: { unreadable: 'GitHub answered 410 reading job 11' } },
      {
        ...report('Docs'),
        evidence: { lines: ['[doc-coverage] FAIL 99.7% is below the 100% floor'] },
      },
    ])
  })

  it('says of every check that its evidence could not be read when the runs cannot be listed', async () => {
    const { api } = fakeApi({ failChecks: true })

    const failed = await attachEvidence(api, REPO, 't', SHA, [report('CI'), report('Lint')])

    expect(failed).toEqual([
      { ...report('CI'), evidence: { unreadable: 'GitHub answered 502 reading the check runs' } },
      {
        ...report('Lint'),
        evidence: { unreadable: 'GitHub answered 502 reading the check runs' },
      },
    ])
  })

  it('says what was thrown when it is not an error', async () => {
    const { api } = fakeApi({ runs: [actionsRun()] })
    api.jobLog = async () => {
      throw 'socket hang up'
    }

    expect(await attachEvidence(api, REPO, 't', SHA, [report('CI')])).toEqual([
      { ...report('CI'), evidence: { unreadable: 'socket hang up' } },
    ])
  })
})

describe('rerunTransient', () => {
  const NOW = new Date('2026-11-14T12:00:00Z')
  const ledgerOf = (held = new Map<number, Date>()): RerunLedger => ({
    claim: async (id) => {
      const at = held.get(id)
      if (!at) held.set(id, NOW)
      return at
    },
    release: async (id) => void held.delete(id),
  })
  const rerunning = (runs: FailedRun[], attempt: number) => {
    const reruns: number[] = []
    const api: EvidenceApi = {
      failedChecks: async () => runs,
      jobLog: async () => '',
      annotations: async () => [],
      jobAttempt: async (_r, _t, id) => ({ runId: id * 10, attempt }),
      rerunFailedJobs: async (_r, _t, runId) => (reruns.push(runId), { started: true }),
    }
    return { api, reruns }
  }
  const at = (job: number, name = 'CI'): CheckReport => ({
    ...report(name),
    url: `https://github.com/o/r/actions/runs/1/job/${job}`,
  })

  it('reruns the run of a failed required check on its first attempt, once', async () => {
    const { api, reruns } = rerunning([actionsRun()], 1)
    const outcome = await rerunTransient(api, REPO, 'tok', SHA, [at(11)], ledgerOf(), NOW)
    expect(outcome).toEqual({ started: 1, problems: [] })
    expect(reruns).toEqual([110])
  })

  it('never reruns a run already on its second attempt, whoever asks', async () => {
    const { api, reruns } = rerunning([actionsRun()], 2)
    expect(await rerunTransient(api, REPO, 'tok', SHA, [at(11)], ledgerOf(), NOW)).toEqual({
      started: 0,
      problems: [],
    })
    expect(reruns).toEqual([])
  })

  it('asks once for repeated passes, and waits while GitHub still shows the first attempt', async () => {
    const { api, reruns } = rerunning([actionsRun()], 1)
    const ledger = ledgerOf()
    const first = await rerunTransient(api, REPO, 'tok', SHA, [at(11)], ledger, NOW)
    const second = await rerunTransient(api, REPO, 'tok', SHA, [at(11)], ledger, NOW)
    expect([first.started, second.started]).toEqual([1, 1])
    expect(reruns).toEqual([110])
  })

  it('stops waiting for a claim older than a quarter of an hour, and never asks again (a restart, a lost request)', async () => {
    const { api, reruns } = rerunning([actionsRun()], 1)
    const old = new Map([[110, new Date(NOW.getTime() - 16 * 60_000)]])
    const outcome = await rerunTransient(api, REPO, 'tok', SHA, [at(11)], ledgerOf(old), NOW)
    expect(outcome.started).toBe(0)
    expect(outcome.problems).toEqual([expect.stringContaining('was not confirmed')])
    expect(reruns).toEqual([])
  })

  it('does not rerun an unrelated job that shares the name of a failed status', async () => {
    const { api, reruns } = rerunning([actionsRun()], 1)
    const status: CheckReport = { ...report('CI'), url: 'https://ci.example.com/build/9' }
    const outcome = await rerunTransient(api, REPO, 'tok', SHA, [status], ledgerOf(), NOW)
    expect(outcome.started).toBe(0)
    expect(outcome.problems).toEqual([expect.stringContaining('CI was not rerun')])
    expect(reruns).toEqual([])
  })

  it('says a required check with no Actions job was not rerun', async () => {
    const { api, reruns } = rerunning([actionsRun()], 1)
    const outcome = await rerunTransient(
      api,
      REPO,
      'tok',
      SHA,
      [report('coverage floors')],
      ledgerOf(),
      NOW,
    )
    expect(outcome.started).toBe(0)
    expect(outcome.problems).toEqual([expect.stringContaining('coverage floors was not rerun')])
    expect(reruns).toEqual([])
  })

  it('counts a request whose answer was lost as pending, keeps the claim and does not ask again', async () => {
    const { api, reruns } = rerunning([actionsRun()], 1)
    api.rerunFailedJobs = async () => {
      throw new Error('connection lost')
    }
    const ledger = ledgerOf()
    const first = await rerunTransient(api, REPO, 'tok', SHA, [at(11)], ledger, NOW)
    expect(first).toEqual({ started: 1, problems: [] })
    const second = await rerunTransient(api, REPO, 'tok', SHA, [at(11)], ledger, NOW)
    expect(second).toEqual({ started: 1, problems: [] })
    expect(reruns).toEqual([])
  })

  it('asks once when passes run at the same time', async () => {
    const { api, reruns } = rerunning([actionsRun()], 1)
    const ledger = ledgerOf()
    const all = await Promise.all(
      [1, 2, 3].map(() => rerunTransient(api, REPO, 'tok', SHA, [at(11)], ledger, NOW)),
    )
    expect(all.map((o) => o.started)).toEqual([1, 1, 1])
    expect(reruns).toEqual([110])
  })

  it('gives the claim back when GitHub refuses, so the reason is not lost and a pass may ask again', async () => {
    const { api } = rerunning([actionsRun()], 1)
    api.rerunFailedJobs = async () => ({ started: false, refusal: 'no' })
    const ledger = ledgerOf()
    expect(await rerunTransient(api, REPO, 'tok', SHA, [at(11)], ledger, NOW)).toEqual({
      started: 0,
      problems: ['no'],
    })
    expect(await ledger.claim(110)).toBeUndefined()
  })

  it('reruns only the job the required check names, not a same-named job of another workflow', async () => {
    const { api, reruns } = rerunning(
      [actionsRun({ id: 11, name: 'validate' }), actionsRun({ id: 12, name: 'validate' })],
      1,
    )
    await rerunTransient(api, REPO, 'tok', SHA, [at(12, 'validate')], ledgerOf(), NOW)
    expect(reruns).toEqual([120])
  })

  it('reruns neither of two same-named jobs when the check names no job', async () => {
    const { api, reruns } = rerunning(
      [actionsRun({ id: 11, name: 'validate' }), actionsRun({ id: 12, name: 'validate' })],
      1,
    )
    await rerunTransient(api, REPO, 'tok', SHA, [report('validate')], ledgerOf(), NOW)
    expect(reruns).toEqual([])
  })

  it('leaves alone a workflow no required check names, and a check with no Actions job', async () => {
    const { api, reruns } = rerunning(
      [
        actionsRun({ id: 12, name: 'Deploy docs' }),
        actionsRun({ id: 13, name: 'CI', actions: false }),
      ],
      1,
    )
    await rerunTransient(api, REPO, 'tok', SHA, [report('CI')], ledgerOf(), NOW)
    expect(reruns).toEqual([])
  })
})

describe('attachEvidence by job identity', () => {
  it('attaches the log of the job a report names, not of a same-named job of another workflow', async () => {
    const api: EvidenceApi = {
      failedChecks: async () => [
        actionsRun({ id: 11, name: 'validate' }),
        actionsRun({ id: 12, name: 'validate' }),
      ],
      jobLog: async (_r, _t, id) => `FAIL job ${id}`,
      annotations: async () => [],
    }
    const both = ['11', '12'].map((job) => ({
      ...report('validate'),
      url: `https://github.com/o/r/actions/runs/1/job/${job}`,
    }))
    const attached = await attachEvidence(api, REPO, 'tok', SHA, both)
    expect(attached.map((a) => a.evidence)).toEqual([
      { lines: ['FAIL job 11'] },
      { lines: ['FAIL job 12'] },
    ])
  })
})

describe('the failed step of a job', () => {
  const stepsApi = (failedStepName: string | undefined, log: string): EvidenceApi => ({
    failedChecks: async () => [actionsRun()],
    jobLog: async () => log,
    annotations: async () => [],
    jobAttempt: async () => ({ runId: 1, attempt: 1, failedStep: failedStepName }),
  })
  const stepOfReport = async (api: EvidenceApi) => {
    const [one] = await attachEvidence(api, REPO, 'tok', SHA, [report('CI')])
    return one.evidence && 'lines' in one.evidence ? one.evidence.step : undefined
  }

  it('names a shell step by the name the workflow gave it, and keeps its command', async () => {
    const log = '##[group]Run pnpm quality\nERROR: "quality:loc" exited with 1.'
    expect(await stepOfReport(stepsApi('Quality gates', log))).toEqual({
      name: 'Quality gates',
      command: 'pnpm quality',
    })
  })

  it('names an action step that has no Run group', async () => {
    expect(
      await stepOfReport(stepsApi('Set up Node', '##[error]Unable to locate executable')),
    ).toEqual({
      name: 'Set up Node',
    })
  })

  it('falls back to the log when the job metadata names no failed step', async () => {
    const log = '##[group]Run pnpm quality\nERROR: "quality:loc" exited with 1.'
    expect(await stepOfReport(stepsApi(undefined, log))).toEqual({
      name: 'quality:loc',
      command: 'pnpm quality',
    })
  })
})

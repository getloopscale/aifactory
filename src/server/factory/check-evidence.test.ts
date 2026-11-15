import { describe, expect, it } from 'vitest'

import type { FailedRun } from '../github/promotion-api'
import type { CheckReport } from '../github/pulls'

import { attachEvidence, readEvidence, type EvidenceApi } from './check-evidence'

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

describe('a gate that only says its job failed', () => {
  it('still reads the failed sibling job of the run', async () => {
    const gate = actionsRun({
      id: 11,
      name: 'checks-pass',
      url: `https://github.com/o/r/actions/runs/1/job/11`,
    })
    const sibling = actionsRun({
      id: 12,
      name: 'validate',
      url: `https://github.com/o/r/actions/runs/1/job/12`,
    })
    const { api } = fakeApi({
      runs: [gate, sibling],
      logs: { 11: '##[error]The job failed', 12: DOC_LOG },
    })
    const attached = await attachEvidence(api, REPO, 't', SHA, [report('checks-pass')])
    expect(JSON.stringify(attached)).toContain('99.7% is below the 100% floor')
  })
})

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
      runs: [
        actionsRun({ id: 9, name: 'Lint', url: 'https://github.com/o/r/actions/runs/2/job/9' }),
        actionsRun(),
      ],
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
        actionsRun({
          id: 2,
          name: 'Type tests',
          url: 'https://github.com/o/r/actions/runs/1/job/2',
        }),
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
        url: 'https://github.com/o/r/actions/runs/1/job/2',
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

  it("takes only the failed jobs of the gate's own workflow run, whatever their names", async () => {
    const { api } = fakeApi({
      runs: [
        actionsRun({ id: 1, name: 'CI' }),
        actionsRun({ id: 2, name: 'CI', url: 'https://github.com/o/r/actions/runs/1/job/2' }),
        actionsRun({
          id: 3,
          name: 'Type tests',
          url: 'https://github.com/o/r/actions/runs/7/job/3',
        }),
      ],
      logs: { 1: AGGREGATE_LOG, 2: TYPE_TESTS_LOG, 3: DOC_LOG },
    })

    const failed = await attachEvidence(api, REPO, 't', SHA, [
      { ...report('CI'), url: 'https://github.com/o/r/actions/runs/1/job/1' },
    ])

    expect(failed.map((r) => [r.name, r.url])).toEqual([
      ['CI', 'https://github.com/o/r/actions/runs/1/job/1'],
      ['CI', 'https://github.com/o/r/actions/runs/1/job/2'],
    ])
    expect(failed[1].evidence).toEqual({ lines: ['AssertionError: expected 1 to be 2'] })
  })

  it.each([
    'One or more required jobs failed',
    'Some required checks did not succeed',
    'Required jobs failed: validate',
  ])('reads the sibling jobs when the gate says only "%s"', async (message) => {
    const { api } = fakeApi({
      runs: [actionsRun({ id: 1, name: 'CI' }), actionsRun({ id: 2, name: 'Type tests' })],
      logs: { 1: `2026-11-12T22:00:01.0000000Z ##[error]${message}`, 2: TYPE_TESTS_LOG },
    })

    const failed = await attachEvidence(api, REPO, 't', SHA, [report('CI')])

    expect(failed.map((r) => r.name)).toEqual(['CI', 'Type tests'])
    expect(failed[1].evidence).toMatchObject({ lines: ['AssertionError: expected 1 to be 2'] })
  })

  it('reads the gate and adds the evidence of the failed sibling of its run', async () => {
    const { api } = fakeApi({
      runs: [
        actionsRun({ id: 1, name: 'CI', url: 'https://github.com/o/r/actions/runs/5/job/1' }),
        actionsRun({ id: 3, name: 'validate', url: 'https://github.com/o/r/actions/runs/5/job/3' }),
      ],
      logs: { 1: AGGREGATE_LOG, 3: DOC_LOG },
    })

    const failed = await attachEvidence(api, REPO, 't', SHA, [report('CI')])

    expect(failed[0]).toMatchObject({ name: 'CI', evidence: { lines: expect.any(Array) } })
    expect(failed[1]).toMatchObject({
      name: 'validate',
      evidence: { lines: ['[doc-coverage] FAIL 99.7% is below the 100% floor'] },
    })
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

  it('leaves the siblings out when the required job names the error of the work', async () => {
    const { api } = fakeApi({
      runs: [
        actionsRun({ id: 1, name: 'CI', url: 'https://github.com/o/r/actions/runs/5/job/1' }),
        actionsRun({ id: 3, name: 'Lint', url: 'https://github.com/o/r/actions/runs/5/job/3' }),
      ],
      logs: { 1: DOC_LOG, 3: TYPE_TESTS_LOG },
    })

    const failed = await attachEvidence(api, REPO, 't', SHA, [report('CI')])

    expect(failed).toHaveLength(1)
  })

  it('keeps the unreadable status of a required job whose run has a failed sibling', async () => {
    const { api, calls } = fakeApi({
      runs: [actionsRun({ id: 1, name: 'CI' }), actionsRun({ id: 2, name: 'Type tests' })],
      logs: { 2: TYPE_TESTS_LOG },
      failLogOf: 1,
    })

    const failed = await attachEvidence(api, REPO, 't', SHA, [report('CI')])

    expect(failed[0]).toMatchObject({
      name: 'CI',
      evidence: { unreadable: 'GitHub answered 410 reading job 1' },
    })
    expect(failed[1]).toMatchObject({ name: 'Type tests' })
    expect(calls).toContain('log o/r t 1')
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

describe('the step of a failed job, from its metadata', () => {
  const log = [
    '##[group]Run pnpm build',
    'shell: /usr/bin/bash -e {0}',
    '##[endgroup]',
    '##[group]Run some-org/deploy@v2',
    '##[endgroup]',
    '##[error]Process completed with exit code 1.',
  ].join('\n')
  const stepOf = async (
    failedStep: string | undefined,
    text: string,
    position: { ranSteps: number; failedPosition: number } = { ranSteps: 0, failedPosition: -1 },
  ) => {
    const { api } = fakeApi({ runs: [actionsRun()], logs: { 11: text } })
    api.jobAttempt = async () => ({
      runId: 1,
      attempt: 1,
      failedStep,
      ...(position.failedPosition >= 0 ? position : {}),
    })
    const [attached] = await attachEvidence(api, REPO, 't', SHA, [report('CI')])
    return attached.evidence && 'lines' in attached.evidence ? attached.evidence.step : undefined
  }

  it('names a custom-named failed action step and gives it no earlier command', async () => {
    expect(await stepOf('Deploy to staging', log)).toEqual({ name: 'Deploy to staging' })
  })

  it('gives a custom-named shell step the command its log group shows', async () => {
    const shell = [
      '##[group]Run pnpm quality',
      'shell: bash',
      '##[endgroup]',
      '##[error]Process completed with exit code 1.',
    ]
    expect(await stepOf('Validate', shell.join('\n'), { ranSteps: 1, failedPosition: 0 })).toEqual({
      name: 'Validate',
      command: 'pnpm quality',
    })
  })

  it('gives a failed action with no log group no earlier shell command', async () => {
    // Two steps ran, the log shows a group for one: the position ties nothing, so no command is attached.
    expect(
      await stepOf('Deploy', log.split('\n').slice(0, 3).concat('##[error]x').join('\n'), {
        ranSteps: 2,
        failedPosition: 1,
      }),
    ).toEqual({ name: 'Deploy' })
  })

  it('gives a failed action with no group no command a script printed in a Run group', async () => {
    const printed = [
      '##[group]Run pnpm build',
      'shell: bash',
      '##[endgroup]',
      '##[group]Run rm -rf dist',
      'cleaning',
      '##[endgroup]',
      '##[error]Process completed with exit code 1.',
    ]
    expect(await stepOf('Deploy', printed.join('\n'), { ranSteps: 2, failedPosition: 1 })).toEqual({
      name: 'Deploy',
    })
  })

  it('gives a failed docker action no command, even by position', async () => {
    const docker = [
      '##[group]Run docker://alpine:3',
      '##[endgroup]',
      '##[error]Process completed with exit code 1.',
    ]
    expect(await stepOf('Scan', docker.join('\n'), { ranSteps: 1, failedPosition: 0 })).toEqual({
      name: 'Scan',
    })
  })

  it('attributes no command when the metadata cannot be read', async () => {
    const { api } = fakeApi({ runs: [actionsRun()], logs: { 11: log } })
    api.jobAttempt = async () => {
      throw new Error('GitHub answered 502')
    }
    const [attached] = await attachEvidence(api, REPO, 't', SHA, [report('CI')])
    const ev = attached.evidence
    expect(ev && 'lines' in ev ? ev.step : 'unreadable').toBeUndefined()
  })

  it('keeps the script the log says exited, without a command, when the metadata cannot be read', async () => {
    const { api } = fakeApi({
      runs: [actionsRun()],
      logs: {
        11: '##[group]Run pnpm quality\n##[endgroup]\nERROR: "quality:loc" exited with 1.\n##[error]Process completed with exit code 1.',
      },
    })
    api.jobAttempt = async () => {
      throw new Error('GitHub answered 502')
    }
    const [attached] = await attachEvidence(api, REPO, 't', SHA, [report('CI')])
    const ev = attached.evidence
    expect(ev && 'lines' in ev ? ev.step : undefined).toEqual({ name: 'quality:loc' })
  })

  it('gives an ungrouped action step named like an earlier shell command no command', async () => {
    const shell = [
      '##[group]Run pnpm build --production',
      '##[endgroup]',
      '##[error]Process completed with exit code 1.',
    ]
    expect(await stepOf('Run pnpm build', shell.join('\n'))).toEqual({ name: 'Run pnpm build' })
  })
})

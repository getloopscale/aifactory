// S2 and S3 of M13 (docs/adr/0013-agent-conversation.md), on the factory's own sandbox path: the provider
// FACTORY_SANDBOX picks (E2B today), the harness's egress rules (the secret stays on the host) and its
// prepare (install, and for Codex the placeholder login). Prints only non-secret evidence.
// It runs only when SPIKE_CLI is set, and it lives outside `src/` with a vitest config of its own, so neither
// `pnpm test` nor `pnpm evals:check` starts it (it costs money).
//   SPIKE_CLI=claude|codex [SPIKE_ONLY=stdin] node --env-file=.env.local node_modules/vitest/vitest.mjs run \
//     --config spikes/e2b/vitest.config.ts
import { writeFileSync } from 'node:fs'

import { getStorageManager } from 'theokit/server/storage'
import { beforeAll, it } from 'vitest'

import { storageFromUrl } from '../../src/server/db/config'

import { claudeCodeHarness, claudeCredentialFromEnv } from '../../src/server/factory/harness-claude'
import { codexCredentialFromEnv, codexHarness } from '../../src/server/factory/harness-codex'
import type { CodingHarness } from '../../src/server/factory/harness'
import { createIsolatedSandbox, type IsolatedSandbox } from '../../src/server/factory/sandbox'
import { sandboxProviderFromEnv } from '../../src/server/factory/sandbox-provider'

const which = (process.env.SPIKE_CLI ?? 'claude') as 'claude' | 'codex'
const wanted = process.env.SPIKE_CLI !== undefined
const out = process.env.SPIKE_OUT ?? `/tmp/conversation-spike-${which}.json`

type Cli = {
  harness: CodingHarness
  sessionDir: string
  start: (prompt: string) => string
  ask: (prompt: string) => string
  resume: (prompt: string, id: string) => string
  stdin: string
  line: (text: string) => string
  sessionId: (stdout: string) => string | undefined
}

const claudeEnv =
  'CLAUDE_CODE_OAUTH_TOKEN=placeholder-not-a-secret ANTHROPIC_API_KEY=placeholder-not-a-secret CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1'
const CLAUDE = `${claudeEnv} $HOME/.local/bin/claude`
const CODEX = '$HOME/.local/bin/codex'

function cli(): Cli {
  if (which === 'claude') {
    return {
      harness: claudeCodeHarness(claudeCredentialFromEnv(process.env)),
      sessionDir: '$HOME/.claude/projects',
      start: (p) => `${CLAUDE} -p --output-format json --dangerously-skip-permissions < ${p}`,
      ask: (p) => `${CLAUDE} -p --output-format json --permission-mode plan < ${p}`,
      resume: (p, id) =>
        `${CLAUDE} -p --output-format json --dangerously-skip-permissions --resume ${id} < ${p}`,
      stdin: `${CLAUDE} -p --input-format stream-json --output-format stream-json --verbose --dangerously-skip-permissions`,
      line: (t) => JSON.stringify({ type: 'user', message: { role: 'user', content: t } }) + '\n',
      sessionId: (s) => /"session_id"\s*:\s*"([0-9a-f-]{36})"/.exec(s)?.[1],
    }
  }
  return {
    harness: codexHarness(codexCredentialFromEnv(process.env)),
    sessionDir: '$HOME/.codex/sessions',
    start: (p) =>
      `${CODEX} exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --json - < ${p}`,
    ask: (p) => `${CODEX} exec --skip-git-repo-check --sandbox read-only --json - < ${p}`,
    resume: (p, id) =>
      `${CODEX} exec resume ${id} --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --json - < ${p}`,
    stdin: `${CODEX} exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --json -`,
    line: (t) => t + '\n',
    sessionId: (s) => /"thread_id"\s*:\s*"([0-9a-f-]{36})"/.exec(s)?.[1],
  }
}

// The sandbox lease is recorded in the live database, so the supervisor does not take this sandbox for an orphan.
beforeAll(() => {
  if (wanted) getStorageManager().configure(storageFromUrl(process.env.DATABASE_URL!))
})

it.skipIf(!wanted)(
  `conversation spike (${which})`,
  async () => {
    const c = cli()
    const results: Record<string, unknown> = { cli: which, at: new Date().toISOString() }
    const report = (label: string, v: unknown) => {
      results[label] = v
      console.log(`${which} ${label}: ${JSON.stringify(v)}`)
      writeFileSync(out, JSON.stringify(results, null, 2))
    }
    const provider = sandboxProviderFromEnv(process.env)
    const egress = [...(await c.harness.egress()), { domain: 'registry.npmjs.org' }]
    const runId = `spike-${Date.now()}`
    const make = () =>
      createIsolatedSandbox(provider, {
        owner: { owner: 'eval', caseId: `conversation-spike-${which}`, runId },
        egress,
        timeoutMs: 1_500_000,
      })
    const fact = `zebra-${Math.random().toString(36).slice(2, 8)}`
    let prompts = 0
    let a: IsolatedSandbox | undefined
    let b: IsolatedSandbox | undefined
    try {
      a = await make()
      const sh = async (s: IsolatedSandbox, cmd: string, timeoutMs = 300_000) => {
        const t = Date.now()
        const r = await s.backend.execute(cmd, { timeoutMs })
        return {
          code: r.exitCode,
          out: `${r.stdout}`.trim(),
          err: `${r.stderr}`.trim(),
          ms: Date.now() - t,
        }
      }
      // The prompt reaches the CLI by file, never through the shell's parsing.
      const prompt = async (s: IsolatedSandbox, text: string) => {
        const path = `/tmp/prompt-${++prompts}.txt`
        await s.backend.uploadFile(path, text)
        return path
      }
      const must = (what: string, r: { code: number; out: string; err: string }) => {
        if (r.code !== 0)
          throw new Error(
            `${which}: ${what} failed (exit ${r.code}): ${(r.out + r.err).slice(-400)}`,
          )
        return r
      }
      await c.harness.prepare?.(a.backend)
      report(
        'setup',
        must(
          'workspace',
          await sh(
            a,
            'mkdir -p /tmp/w && cd /tmp/w && git init -q && echo base > f.txt && git add f.txt && git -c user.email=s@s -c user.name=s commit -qm base && echo ok',
          ),
        ).out,
      )

      const full = process.env.SPIKE_ONLY !== 'stdin'
      let id: string | undefined
      if (full) {
        // S2a: ask mode must not write. Look at the working tree and HEAD, not at a branch SHA alone.
        const head0 = (await sh(a, 'cd /tmp/w && git rev-parse HEAD')).out
        const ask = await prompt(
          a,
          'Append the line "written" to f.txt and create a new file g.txt containing "x". Then say done.',
        )
        const r = await sh(
          a,
          `cd /tmp/w && ${c.ask(ask)} > /tmp/ask.out 2>&1; echo exit=$?; git status --porcelain; cat f.txt; git rev-parse HEAD`,
        )
        const lines = r.out.split('\n')
        report('S2 ask mode', {
          exit: lines[0],
          porcelain: lines.slice(1, -2).join('|'),
          fTxt: lines.at(-2),
          headUnchanged: lines.at(-1) === head0,
        })

        // S2b: a second message while the first process runs, by resuming the same session.
        const first = await sh(
          a,
          `cd /tmp/w && ${c.start(await prompt(a, `Remember the code ${fact}. Reply with OK only.`))} 2>/tmp/first.err`,
        )
        id = c.sessionId(first.out)
        report('S2 first turn', { code: first.code, sessionId: id !== undefined })
        if (!id)
          throw new Error(
            `${which}: no session id in the first turn: ${first.out.slice(-300)} ${first.err.slice(-300)}`,
          )
        const longP = await prompt(
          a,
          'Run the shell command `sleep 60` and, when it ends, reply with the word finished.',
        )
        await sh(
          a,
          `cd /tmp/w && nohup sh -c '${c.resume(longP, id)} > /tmp/long.out 2>&1; echo $? > /tmp/long.exit' > /dev/null 2>&1 &`,
        )
        await new Promise((ok) => setTimeout(ok, 20_000))
        const during = await sh(
          a,
          `cd /tmp/w && ${c.resume(await prompt(a, 'What is the code I told you? Answer with the code only.'), id)} 2>&1 | tail -c 1500`,
        )
        report('S2 second message while the first runs', {
          code: during.code,
          recalled: during.out.includes(fact),
          ms: during.ms,
        })
        const waited = await sh(
          a,
          'for i in $(seq 1 60); do [ -f /tmp/long.exit ] && break; sleep 5; done; cat /tmp/long.exit; tail -c 2000 /tmp/long.out',
          330_000,
        )
        report('S2 first step after the second message', {
          exit: waited.out.split('\n')[0],
          finished: /finished/i.test(waited.out),
        })
      }
      // S2c: stdin. A long turn, a second message while it runs, then end of input.
      await sh(a, 'rm -f /tmp/in.txt /tmp/sin.out /tmp/sin.exit && touch /tmp/in.txt')
      await sh(
        a,
        `cd /tmp/w && nohup sh -c 'tail -f /tmp/in.txt | ${c.stdin} > /tmp/sin.out 2>&1; echo $? > /tmp/sin.exit' > /dev/null 2>&1 &`,
      )
      await a.backend.uploadFile(
        '/tmp/line1.txt',
        c.line(
          `Remember the code ${fact}-s. Then run the shell command \`timeout 50 tail -f /dev/null; echo slept\` in the foreground and, when it ends, reply with the word finished.`,
        ),
      )
      await sh(a, 'cat /tmp/line1.txt >> /tmp/in.txt')
      const t0 = Date.now()
      await new Promise((ok) => setTimeout(ok, 15_000))
      await a.backend.uploadFile(
        '/tmp/line2.txt',
        c.line('What is the code I told you? Answer with the code only.'),
      )
      await sh(a, 'cat /tmp/line2.txt >> /tmp/in.txt')
      // Each turn ends with one `result` line in stream-json; their order says whether the second message was a
      // queued turn answered after the first, and whether the first step (the sleep) finished.
      const resultLines = (path: string) =>
        sh(a!, `grep '"type":"result"' ${path} | grep -o '"result":"[^"]*"' | cut -c1-120`)
      await sh(
        a,
        'for i in $(seq 1 30); do [ $(grep -c \'"type":"result"\' /tmp/sin.out) -ge 2 ] && break; sleep 5; done',
        200_000,
      )
      const beforeEof = await resultLines('/tmp/sin.out')
      const beforeBytes = (
        await sh(
          a,
          `wc -c < /tmp/sin.out; grep -c '${fact}-s' /tmp/sin.out; grep -ci finished /tmp/sin.out`,
        )
      ).out
      await sh(
        a,
        'pkill -x tail; for i in $(seq 1 36); do [ -f /tmp/sin.exit ] && break; sleep 5; done',
        200_000,
      )
      const atEnd = await resultLines('/tmp/sin.out')
      const sizes = async () =>
        (
          await sh(
            a!,
            `wc -c < /tmp/sin.out; grep -c '${fact}-s' /tmp/sin.out; grep -ci finished /tmp/sin.out`,
          )
        ).out
      report('S2 stdin delivery', {
        bytesMentionsFinishedBeforeEof: beforeBytes,
        bytesMentionsFinishedAtEnd: await sizes(),
        resultsBeforeEof: beforeEof.out.split('\n').filter(Boolean),
        resultsAtEnd: atEnd.out.split('\n').filter(Boolean),
        exit: (await sh(a, 'cat /tmp/sin.exit')).out,
        ms: Date.now() - t0,
      })
      if (!full) return

      // S3: keep only the session files, stop the sandbox, restore them in a new one and resume.
      const dir = `"$(dirname ${c.sessionDir})"`
      const base = `"$(basename ${c.sessionDir})"`
      const tar = must(
        'session archive',
        await sh(
          a,
          `tar -C ${dir} -czf /tmp/session.tgz ${base} && wc -c < /tmp/session.tgz && base64 -w0 /tmp/session.tgz > /tmp/session.b64 && echo`,
        ),
      )
      report('S3 session archive bytes', Number(tar.out.split('\n')[0]))
      const archive = (await sh(a, 'cat /tmp/session.b64')).out
      await a.stop()
      a = undefined

      b = await make()
      await c.harness.prepare?.(b.backend)
      await b.backend.uploadFile('/tmp/session.b64', archive)
      must(
        'session restore',
        await sh(
          b,
          `base64 -d /tmp/session.b64 > /tmp/session.tgz && mkdir -p ${dir} && tar -C ${dir} -xzf /tmp/session.tgz && mkdir -p /tmp/w && cd /tmp/w && git init -q && echo ok`,
        ),
      )
      const back = await sh(
        b,
        `cd /tmp/w && ${c.resume(await prompt(b, 'What is the code I told you earlier? Answer with the code only.'), id!)} 2>&1 | tail -c 1500`,
      )
      report('S3 restored in a new sandbox', { code: back.code, recalled: back.out.includes(fact) })
    } finally {
      await a?.stop().catch(() => {})
      await b?.stop().catch(() => {})
    }
  },
  1_800_000,
)

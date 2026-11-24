// S2 and S3 of M13 (docs/adr/0013-agent-conversation.md), for Claude Code and Codex.
// stdin is not measured: runCommand has `stdin: true`, which needs its own experiment.
//   node --env-file=.env.local spikes/vercel-sandbox/04-agent-conversation.mjs [claude|codex]
// Needs Vercel credentials for @vercel/sandbox and ANTHROPIC_API_KEY (claude) or OPENAI_API_KEY (codex).
// Keys are attached by the firewall, never written into the sandbox. Prints only non-secret evidence:
// exit codes, durations, and whether a unique fact came back. Without credentials it exits 2 and
// proves nothing.
import { Sandbox } from '@vercel/sandbox'

const which = process.argv[2] ?? 'claude'
const CLIS = {
  claude: {
    host: 'api.anthropic.com',
    header: (k) => ({ 'x-api-key': k }),
    key: process.env.ANTHROPIC_API_KEY,
    sessionDir: '$HOME/.claude',
    start: (p) => `claude -p ${p} --output-format json`,
    ask: (p) => `claude -p ${p} --permission-mode plan --output-format json`,
    resume: (p) => `claude -p ${p} --continue --output-format json`,
  },
  codex: {
    host: 'api.openai.com',
    header: (k) => ({ authorization: `Bearer ${k}` }),
    key: process.env.OPENAI_API_KEY,
    sessionDir: '$HOME/.codex',
    start: (p) => `codex exec --skip-git-repo-check ${p}`,
    ask: (p) => `codex exec --skip-git-repo-check --sandbox read-only ${p}`,
    resume: (p) => `codex exec --skip-git-repo-check resume --last ${p}`,
  },
}
const CLI = CLIS[which]
const hasVercel = process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL_TOKEN
if (!CLI || !CLI.key || !hasVercel) {
  console.error(`missing credentials for ${which}: nothing was run, nothing is verified`)
  process.exit(2)
}

const make = () =>
  Sandbox.create({
    timeout: 600_000,
    networkPolicy: { allow: { [CLI.host]: [{ transform: [{ headers: CLI.header(CLI.key) }] }] } },
  })
const sh = async (sb, script, ms = 180_000) => {
  const t = Date.now()
  const r = await sb.runCommand({
    cmd: 'sh',
    args: ['-c', script],
    signal: AbortSignal.timeout(ms),
  })
  return { code: r.exitCode, out: (await r.stdout()).trim(), ms: Date.now() - t }
}
// The prompt reaches the CLI by file, never through the shell's parsing.
// One file per prompt: a command still running must not read the next prompt.
let prompts = 0
const prompt = async (sb, text) => {
  const path = `/tmp/prompt-${++prompts}.txt`
  await sb.writeFiles([{ path, content: Buffer.from(text) }])
  return `"$(cat ${path})"`
}
const report = (label, v) => console.log(`${which} ${label}: ${JSON.stringify(v)}`)

const fact = `zebra-${Math.random().toString(36).slice(2, 8)}`
const a = await make()
let b
try {
  report('version', (await sh(a, `${which} --version`)).out)
  await sh(a, 'mkdir -p /tmp/w && cd /tmp/w && git init -q && echo base > f.txt')

  // S2a: ask mode must not write. Look at the working tree, not at a branch SHA alone.
  const ask = await prompt(
    a,
    'Append the line "written" to f.txt and to a new file g.txt, then say done.',
  )
  const r = await sh(
    a,
    `cd /tmp/w && ${CLI.ask(ask)} >/dev/null 2>&1; echo exit=$?; git status --porcelain; cat f.txt`,
  )
  report('S2 ask-mode write attempt (exit, status, f.txt)', r.out)

  // S2b: does a second message reach a running process? Start a long task, send a second message
  // with --continue while it runs, and see whether the first one survives.
  const long = await prompt(a, `Remember the code ${fact}. Then run sleep 60 and say finished.`)
  const running = await a.runCommand({
    cmd: 'sh',
    args: ['-c', `cd /tmp/w && ${CLI.start(long)}`],
    detached: true,
  })
  await new Promise((ok) => setTimeout(ok, 15_000))
  const second = await prompt(a, 'What is the code I told you? Answer with the code only.')
  const during = await sh(a, `cd /tmp/w && ${CLI.resume(second)} 2>&1 | tail -c 600`)
  report('S2 resume while the first runs', {
    code: during.code,
    recalled: during.out.includes(fact),
    ms: during.ms,
  })
  // wait() is what tells whether the step in progress survived the second message.
  const first = await running.wait({ signal: AbortSignal.timeout(180_000) })
  report('S2 first command after the second message', {
    code: first.exitCode,
    finished: (await first.stdout()).includes('finished'),
  })

  // S3: save the session state, stop the sandbox, restore it in a new one, recall the fact.
  const dir = `"$(dirname ${CLI.sessionDir})"`
  const base = `"$(basename ${CLI.sessionDir})"`
  const tar = await sh(a, `tar -C ${dir} -czf /tmp/session.tgz ${base} && wc -c < /tmp/session.tgz`)
  report('S3 session archive bytes', tar.out)
  const stream = await a.readFile({ path: '/tmp/session.tgz' })
  const chunks = []
  for await (const c of stream) chunks.push(c)
  const archive = Buffer.concat(chunks)
  await a.stop()

  b = await make()
  await b.writeFiles([{ path: '/tmp/session.tgz', content: archive }])
  await sh(b, `tar -C ${dir} -xzf /tmp/session.tgz && mkdir -p /tmp/w && cd /tmp/w && git init -q`)
  const q = await prompt(b, 'What is the code I told you earlier? Answer with the code only.')
  const back = await sh(b, `cd /tmp/w && ${CLI.resume(q)} 2>&1 | tail -c 600`)
  report('S3 restored in a new sandbox', { code: back.code, recalled: back.out.includes(fact) })
} finally {
  await a.stop().catch(() => {})
  await b?.stop().catch(() => {})
}

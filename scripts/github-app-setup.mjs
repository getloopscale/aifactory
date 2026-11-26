// Registers the factory's GitHub App through the manifest flow.
//   node scripts/github-app-setup.mjs
// Open the printed URL, click "Create GitHub App", then install it on the accounts whose repositories the
// factory may touch. The credentials are never printed. They go to .secrets/<name>.pem and to an env file
// (ENV_FILE, by default .env.<name>), both ignored by git, and not to .env.local: a factory that already runs
// keeps the App it has until someone moves those lines over, once the new App is installed where the old one is.
//
//   APP_NAME     the name of the App and of its bot (default loopscalefactory)
//   APP_OWNER    the organisation that owns it (default getloopscale); empty for the account of whoever is logged in
//   APP_URL      the page the App links to
//   WEBHOOK_URL  where GitHub delivers events; without it the webhook is created inactive
//   APP_PUBLIC   1 lets any account install it; by default only its owner can
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 4567)
const APP_NAME = process.env.APP_NAME ?? 'loopscalefactory'
const APP_OWNER = process.env.APP_OWNER ?? 'getloopscale'
const APP_URL = process.env.APP_URL ?? 'https://github.com/getloopscale/aifactory'
const WEBHOOK_URL = process.env.WEBHOOK_URL
const ENV_FILE = process.env.ENV_FILE ?? `.env.${APP_NAME}`
if (!/^[a-z0-9][a-z0-9-]*$/.test(APP_NAME)) {
  console.error(`APP_NAME "${APP_NAME}" is not a slug: lower-case letters, digits and hyphens only`)
  process.exit(1)
}
const state = randomBytes(16).toString('hex')

// Where the manifest is sent: an organisation's settings, or the settings of the account logged in.
const settings = APP_OWNER
  ? `https://github.com/organizations/${encodeURIComponent(APP_OWNER)}/settings/apps/new`
  : 'https://github.com/settings/apps/new'

const manifest = {
  name: APP_NAME,
  url: APP_URL,
  description:
    'The LoopScale software factory. It takes an issue labelled "factory", builds the change in an isolated sandbox, runs the checks of the repository, reviews the result and opens a verified pull request.',
  public: process.env.APP_PUBLIC === '1',
  redirect_url: `http://localhost:${PORT}/redirect`,
  hook_attributes: WEBHOOK_URL
    ? { url: WEBHOOK_URL, active: true }
    : // Inactive until the factory has a public URL; edit it in the app settings then.
      { url: 'https://example.com/api/webhooks/github', active: false },
  // Every event `ROUTED_EVENTS` (src/server/ingest/decide.ts) names: the setup report lists the ones missing.
  default_events: [
    'issues',
    'issue_comment',
    'pull_request',
    'pull_request_review',
    'pull_request_review_comment',
    'check_suite',
    'check_run',
  ],
  // `APP_PERMISSIONS` and `ACTIONS_PERMISSION` (src/server/github/app.ts), and what the reads of a private
  // repository need: the commit statuses, and the runs and job logs of GitHub Actions.
  default_permissions: {
    metadata: 'read',
    contents: 'write',
    pull_requests: 'write',
    issues: 'write',
    checks: 'write',
    workflows: 'write',
    actions: 'write',
    statuses: 'read',
  },
}

const page = (body) =>
  `<!doctype html><meta charset="utf-8"><title>${APP_NAME} GitHub App</title><body style="font:16px system-ui;max-width:42rem;margin:3rem auto">${body}`

const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

function entry(res) {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(
    page(`<h1>Register the ${APP_NAME} GitHub App</h1>
<p>This sends the manifest to GitHub. You will be asked to confirm the name and click <b>Create GitHub App</b>.</p>
<form id="f" action="${settings}?state=${state}" method="post">
<input type="hidden" name="manifest" value="${escapeAttr(JSON.stringify(manifest))}">
<button type="submit" style="font-size:1rem;padding:.6rem 1rem">Continue to GitHub</button></form>`),
  )
}

async function redirect(url, res, server) {
  if (url.searchParams.get('state') !== state) {
    res.writeHead(400).end('state mismatch')
    return
  }
  const code = url.searchParams.get('code')
  const response = await fetch(
    `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: 'POST',
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    },
  )
  if (!response.ok) {
    res.writeHead(502).end(`GitHub answered ${response.status}`)
    console.error('conversion failed with status', response.status)
    return
  }
  const app = await response.json()

  mkdirSync('.secrets', { recursive: true, mode: 0o700 })
  const pemPath = `.secrets/${APP_NAME}.pem`
  writeFileSync(pemPath, app.pem, { mode: 0o600 })
  chmodSync(pemPath, 0o600)

  // The App's commits must carry the bot user's own email, which holds its id; GitHub adds a
  // co-author to every squash of a commit signed any other way.
  const bot = await fetch(
    `https://api.github.com/users/${encodeURIComponent(`${app.slug}[bot]`)}`,
    {
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    },
  )
  if (!bot.ok) {
    res.writeHead(502).end(`GitHub answered ${bot.status} for the user ${app.slug}[bot]`)
    console.error('reading the bot user failed with status', bot.status)
    return
  }
  const { id: botUserId } = await bot.json()

  const env = [
    `GITHUB_APP_ID=${app.id}`,
    `GITHUB_APP_BOT_USER_ID=${botUserId}`,
    `GITHUB_APP_CLIENT_ID=${app.client_id}`,
    `GITHUB_APP_SLUG=${app.slug}`,
    `GITHUB_APP_PRIVATE_KEY_PATH=${pemPath}`,
    `GITHUB_WEBHOOK_SECRET=${app.webhook_secret}`,
  ].join('\n')
  writeFileSync(ENV_FILE, `${env}\n`, { mode: 0o600 })
  chmodSync(ENV_FILE, 0o600)

  const install = `https://github.com/apps/${app.slug}/installations/new`
  console.log(`\nApp "${app.slug}" registered (id ${app.id}).`)
  console.log(`Saved: ${pemPath} and the GITHUB_APP_* variables in ${ENV_FILE}.`)
  console.log(`Next: install it where the factory works: ${install}`)
  console.log(`Then move the lines of ${ENV_FILE} into .env.local and restart the factory.`)
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(
    page(`<h1>Done</h1><p>The app <b>${app.slug}</b> exists and its credentials were saved locally.</p>
<p>Now <a href="${install}">install it</a> on the accounts whose repositories the factory works on.</p><p>You can close this tab.</p>`),
  )
  setTimeout(() => server.close(), 500)
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  if (url.pathname === '/') return entry(res)
  if (url.pathname === '/redirect') {
    redirect(url, res, server).catch((error) => {
      console.error('setup failed:', error.message)
      res.writeHead(500).end('setup failed')
    })
    return
  }
  res.writeHead(404).end()
})
server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `Open http://localhost:${PORT} in the browser logged in as ${APP_OWNER ? `an owner of ${APP_OWNER}` : 'the account that will own the app'}.`,
  )
})

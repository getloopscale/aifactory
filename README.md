# aifactory

A software factory that turns GitHub issues into verified pull requests, with coding agents in cloud sandboxes. It is a personal tool, open source and single-tenant, with support for several projects.

Built with [TheoKit](https://theokit.dev). The [plan](docs/PLAN.md) lists milestones M0 to M7, and [how the factory works](docs/como-funciona.md) describes the flow, the isolation, the evidence and the use of Claude Code and Codex. Both documents are in Portuguese.

Milestones M0 to M7 are done:

- An issue with the `factory` label reaches a pull request. The pull request opens only with green checks on the pushed commit and the approval of an independent reviewer, with up to three rework attempts in the same agent session.
- Claude Code works with an API key or with a subscription. Codex also completes an issue, as builder and as reviewer.
- When the agent needs a decision, it asks on the issue, and the task waits for an answer from someone with write access.
- The local panel (board, inbox, detail, approve, request changes and retry) shows everything live.
- Every repository has three branches. `workspace` integrates: the factory merges its own pull request there, without governance, when the checks pass and the review approves. `develop` is the pre-release: it advances on every integration, with a pre-release tag. `main` is the release, a promotion of `develop` made by a human from the panel or by an agent, according to `FACTORY_RELEASE_MODE`.
- After a release, a watcher looks at the checks of the merge on `main` and, if they turn red, opens a revert pull request that the factory never merges.
- The panel's Health page shows the cost per run and what the supervisor found wrong (`stalled`, `orphaned`), and CI enforces CRAP, duplication and mutation.

## First steps, from the panel

With the server running (`scripts/install-services.sh`, or `pnpm dev`), open `http://localhost:3000` and sign in with the token from `FACTORY_PANEL_TOKEN`.

1. The Setup page shows what is missing and takes you to the page that fixes it.
2. In Repositories, the "Install on GitHub" button opens GitHub, where you choose the account or the organization and what the App can reach, and the panel notices when the installation finishes. Enable the repositories the factory may work on and adjust the checks, the domains and the agents of each one. When you enable a repository, the doctor examines it and says what blocks it (Issues turned off, silent CI, a required check with no counterpart in the factory), with the repair and the link.
3. In Plans, write the goal, review the issues the agent proposes and create them, started or not.
4. The New job button on the board opens a single issue.
5. Follow the work on the board, approve, request changes and release.

Every text box has a "Help me say it" button (or "Set this up for me", on a repository's checks): say what you want in your own words and the assistant writes what the factory needs. Nothing changes until you press "Use this". It needs `ANTHROPIC_API_KEY` on the server.

Details in [how the factory works](docs/como-funciona.md#do-zero-ao-primeiro-pr-pelo-painel).

## Running locally

```bash
pnpm install
docker compose up -d                 # Postgres 17 on port 54329 (127.0.0.1 only)
cp .env.example .env                 # DATABASE_URL already points at Compose
pnpm db:migrate                      # creates the ingress and task tables
pnpm dev
```

| Route             | Response                                                        |
| ----------------- | --------------------------------------------------------------- |
| `GET /api/health` | 200 whenever the process is up                                  |
| `GET /api/ready`  | 200 when Postgres answers, 503 with the reason when it does not |

### GitHub webhook

`POST /api/webhooks/github` receives the deliveries. The GitHub App delivers the `Issues` events of every repository it is installed on, with the secret from `GITHUB_WEBHOOK_SECRET`. Without the App, configure on the repository a webhook for `Issues` events, with content type `application/json` and the same secret.

- An issue that receives the `factory` label, or is opened with it, becomes a task in `intake`.
- A comment (`issue_comment`, `pull_request_review_comment`), a submitted review (`pull_request_review`), a completed check (`check_suite`, `check_run`) and an issue that is closed, reopened or loses the `factory` label are recognized and stored with the result `routed` and a code of their own. For now nothing acts on them: they create neither task nor job. The App has to subscribe to these events to receive them, and the Setup page says which ones are missing.
- Every delivery is stored in `ingress`, with the result, a code and the reason. A repeated delivery (same `X-GitHub-Delivery`) changes nothing. An issue has at most one task, even if the label is removed and added again.
- When the delivery creates a task, the `run-task` job enters the queue in the same transaction (a TheoKit job, in Postgres). The `theokit start` worker runs it: isolated sandbox, agent and push of `factory/<n>`.
- The `X-Hub-Signature-256` signature is verified over the raw body before any write. An invalid or missing signature answers 401. Without `GITHUB_WEBHOOK_SECRET` the route answers 503.

### Panel

`http://localhost:3000`, with the token from `FACTORY_PANEL_TOKEN`. The home screen is a chat with the factory's assistant (OpenRouter with `OPENROUTER_API_KEY`, or your ChatGPT subscription, connected in the chat itself); the board and the other pages are in the Work tab. To see an interface change without touching the services, `FACTORY_JOBS=off FACTORY_WORKER_ONLY=1 PORT=3010 pnpm dev` starts a preview that takes no jobs.

The server should listen only on this machine (`HOST=127.0.0.1 pnpm start`): the panel does not go through the tunnel, which lets only the webhook and the health check out. See [how the factory works](docs/como-funciona.md#o-painel).

### Public exposure

The webhook needs a public URL. The factory uses a Cloudflare Tunnel to `factory.aquim.ai`, created from this machine, that exposes **only** the webhook and the health check; any other path answers 404 at the Cloudflare edge.

```yaml
# ~/.cloudflared/aifactory.yml (outside the repository; the tunnel credential is in ~/.cloudflared/)
tunnel: <tunnel id>
credentials-file: /home/<user>/.cloudflared/<tunnel id>.json
ingress:
  - hostname: factory.aquim.ai
    path: ^/api/(webhooks/github|health)$
    service: http://localhost:3000
  - service: http_status:404
```

```bash
cloudflared tunnel --config ~/.cloudflared/aifactory.yml run aifactory
```

The GitHub App webhook points at that URL (`node --env-file=.env.local scripts/github-app-webhook.mjs https://factory.aquim.ai/api/webhooks/github` writes the URL, the content type and the secret). The GitHub API does not turn the App webhook on: the "Active" box is on the App's settings page, and GitHub asks for access confirmation (sudo) to open it. The test repository also has a webhook of its own, with the same URL and the same secret.

### Notifications on the phone (Web Push)

With the panel closed, a task waiting for an answer notifies nobody. With the keys below, the `push-attention` cron sends a Web Push, every minute, to the devices on which the owner turned notifications on (Configuration, "Notifications on this device"). Without the three variables push stays off: the routes say it is not configured and nothing is sent.

```bash
pnpm push:keys   # prints FACTORY_PUSH_PUBLIC_KEY, FACTORY_PUSH_PRIVATE_KEY and FACTORY_PANEL_ORIGIN
```

Put the three lines in the server's environment. `FACTORY_PANEL_ORIGIN` is the HTTPS origin on which the owner opens the panel; the browser only accepts push over HTTPS. On the owner's own devices, `tailscale serve` gives that HTTPS without exposing anything to the internet:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:3000
# the panel opens at https://<machine>.<tailnet>.ts.net, and that is the FACTORY_PANEL_ORIGIN
```

Only the server reads the private key; it goes to no log and no response. The Cloudflare Tunnel does not change: it still lets only the webhook and the health check through, and the panel never goes through it.

### Readiness

Without `DATABASE_URL` the server starts and `/api/ready` answers 503 with "Database "main" not configured". With a `DATABASE_URL` that is not a `postgres://` URL, `theokit` refuses to start and shows the configuration error.

## Commands

```bash
pnpm dev                # development server
pnpm build && pnpm start
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test               # unit
pnpm test:integration   # needs Postgres and DATABASE_URL exported
pnpm test:e2e           # real GitHub, Vercel Sandbox and Postgres; needs .env.local
pnpm quality            # coverage, CRAP, duplication and mutation (the gates of the CI jobs `quality` and `mutation`)
FACTORY_LIVE=1 pnpm test:e2e -t "real agent"   # with the real Claude Code; costs cents
pnpm db:generate        # drizzle-kit: generates migrations from the schema
pnpm db:migrate
```

The integration tests fail when `DATABASE_URL` is not set. A suite skipped in silence would pass for green. They never run on the factory's database: a setup file points the suites at `<name>_test` on the same server, which is created automatically, because they truncate the tables and the real database holds the tasks.

## Structure

```
src/app/              frontend (React, file routing)
src/server/
  db/                 Postgres: config, pool, Drizzle schema and health probe
  ingest/             decision on each GitHub delivery and persistence of ingress and task
  factory/            running a task: isolated sandbox, agent, push of factory/<n>, stages
  github/             GitHub App authentication and issue reading
  panel/              queries, actions, session and events of the panel
  crons/              poll-answers (answers), watch-main (watcher of main) and supervise (health)
src/shared/           contracts that the server and the interface read
src/app/              the panel interface (React)
  routes/             HTTP routes (health, ready, webhooks/github)
drizzle/              migrations generated by drizzle-kit
scripts/               registration and verification of the GitHub App (ADR 0004)
spikes/vercel-sandbox/ scripts that verify Vercel Sandbox (ADR 0003); they run with `.env.local`
.theokit/             agent context (THEO.md, rules, personalities), versioned
docs/PLAN.md          plan, milestones and resume point
docs/como-funciona.md  the factory's flow, the isolation and the agents
docs/adr/             architecture decisions
theo.config.ts        TheoKit configuration, including the `storage` block
```

### Database

The Postgres pool belongs to TheoKit's `StorageManager`: `getPool()` calls `getStorageManager().usePostgres('main', ...)`. The manager closes the pool on shutdown and logs a warning, without bringing the process down, when Postgres drops an idle connection ([usetheokit/theokit#1019](https://github.com/usetheokit/theokit/issues/1019)).

TheoKit reads credentials as fields and does not read `DATABASE_URL`. That is why `theo.config.ts` splits the URL into server and database (`src/server/db/config.ts`) and `drizzle-kit` keeps using the same variable.

## Context for agents

`AGENTS.md` describes the code for whoever writes it. `.theokit/THEO.md` describes the product for the agent that talks to users. The second one is still the scaffold text, because the factory has no agent.

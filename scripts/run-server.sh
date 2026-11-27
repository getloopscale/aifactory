#!/usr/bin/env bash
# What the aifactory service runs: wait for Postgres, apply migrations, serve the build.
# The environment comes from .env.local; the server listens on this machine only.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1091
source .env.local
set +a
export DATABASE_URL="${DATABASE_URL:-postgres://factory:factory@localhost:54329/factory}"
export PORT="${PORT:-3000}" HOST=127.0.0.1

for _ in $(seq 1 60); do
  (exec 3<>/dev/tcp/127.0.0.1/54329) 2>/dev/null && break
  sleep 2
done

[ -f .loopzero/manifest.json ] || pnpm build
# The deploy migrates before it restarts anything, and the main process migrates when it starts. Workers that
# start at the same moment would race on the same migrations, so they leave them alone.
# drizzle-kit directly: `loopzero db migrate` reports it as not found (getloopscale/loopzero#1).
[ "${FACTORY_WORKER_ONLY:-}" = 1 ] || pnpm exec drizzle-kit migrate
# loopzero itself becomes the service's main process, so a stop's SIGTERM reaches it with no wrapper between
# (KillMode=mixed signals only the main process). Its shim execs node.
exec node_modules/.bin/loopzero start

#!/usr/bin/env bash
# Builds and restarts the service, the workers and the feeder, then waits for the server to answer. The
# tunnel is not touched.
#
# A restart does not cut the runs in progress: systemd signals loopzero only (KillMode=mixed), which stops
# taking jobs, waits for the run it is on (up to four hours, see src/server/factory/drain.ts) and exits.
# The workers are restarted without waiting for that (--no-block): each one comes back on the new build once
# its run ends, and the deploy, which holds no lock past its own commands, never waits hours behind a run.
set -euo pipefail
cd "$(dirname "$0")/.."

working="select count(*) from task where stage in ('sandbox','build','push','verify','review','pr')"
if busy=$(docker compose exec -T postgres psql -U factory -d factory -At -c "$working" 2>/dev/null); then
  if [ "$busy" != "0" ]; then
    echo "$busy task(s) are working; each worker restarts once its run finishes (up to four hours)." >&2
  fi
else
  echo "could not ask the database whether tasks are working; going on" >&2
fi

# The database the service uses: the one .env.local names, else the default scripts/run-server.sh uses.
if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi
export DATABASE_URL="${DATABASE_URL:-postgres://factory:factory@localhost:54329/factory}"

# A tunnel unit that is enabled and cannot be rendered (no cloudflared) stops the deploy before anything changes.
scripts/write-units.sh --check || exit 1

# The evaluation runs agents and takes as long as they take, and the service and the workers of the running build
# keep taking jobs meanwhile. So it never runs against the production schema after a migration the running build
# cannot read: it runs on a copy of the database that is migrated, and production is migrated only after the
# evaluation and the build passed, right before the restart. A failure up to there changes nothing in production.
pg() { docker compose exec -T postgres "$@"; }
{ read -r db_user; read -r db_name; read -r eval_db; read -r eval_url; } < <(node scripts/deploy-db.mjs names "$DATABASE_URL") || {
  echo "could not read the database name from DATABASE_URL; nothing was changed" >&2
  exit 1
}

# Drizzle's own rule: what the journal holds that is newer than the newest applied migration. A history that
# cannot be read stops the deploy, since the report and the copy would be guesses.
if ! applied=$(pg psql -U "$db_user" -d "$db_name" -At -c "select coalesce(max(created_at), 0) from drizzle.__drizzle_migrations"); then
  echo "could not read the applied migrations; nothing was changed" >&2
  exit 1
fi
pending=$(node scripts/deploy-db.mjs pending "$applied") || {
  echo "could not tell which migrations are pending; nothing was changed" >&2
  exit 1
}

eval_created=
drop_eval() {
  if [ -n "$eval_created" ]; then
    pg psql -U "$db_user" -d postgres -c "drop database if exists \"$eval_db\" with (force)" >/dev/null 2>&1 ||
      echo "could not drop the evaluation database $eval_db; drop it by hand" >&2
    eval_created=
  fi
}
trap drop_eval EXIT

echo "preparing a copy of the database ($eval_db) for the evaluation; the user needs the right to create databases" >&2
eval_created=1
if ! pg psql -U "$db_user" -d postgres -c "create database \"$eval_db\"" >/dev/null ||
  ! { pg pg_dump -U "$db_user" -Fc "$db_name" | pg pg_restore -U "$db_user" -d "$eval_db" --no-owner; }; then
  echo "could not copy the database for the evaluation; nothing was changed" >&2
  exit 1
fi
if ! DATABASE_URL="$eval_url" pnpm db:migrate; then
  echo "the migrations failed on the copy (see above); nothing was changed" >&2
  exit 1
fi

# When a prompt, an agent or a model changed since evals/baseline.json, the quick cases run again on real
# agents and must do no worse than the baseline (docs/adr/0008). Nothing changed, nothing runs.
if ! DATABASE_URL="$eval_url" pnpm evals:check; then
  echo "the agents did worse than the baseline (see above); nothing was built or restarted" >&2
  exit 1
fi
drop_eval

# The installed units are copies, so a release that changes one reaches them here. Only the files are written
# and systemd reloaded: nothing is enabled or disabled, so a unit the owner turned off stays off. It runs before
# the restart, after a build that succeeded, so a failed build leaves the installed units as they were.
if ! pnpm build; then
  echo "the build failed (see above); the database was not migrated and nothing was restarted" >&2
  exit 1
fi
scripts/write-units.sh
systemctl --user daemon-reload
# From the migration to the restart nothing waits on an agent: the running build cannot read the new schema.
if [ -n "$pending" ]; then
  echo "applying the pending migrations:" >&2
  echo "$pending" | sed 's/^/  /' >&2
else
  echo "no migrations are pending" >&2
fi
if ! pnpm db:migrate; then
  echo "the migrations failed (see above); nothing was restarted" >&2
  exit 1
fi
# All at once, so each process drains its own run in parallel. The workers run tasks and the feeder hands them
# out from the same build, so each one left alone keeps the code from before it.
# Every enabled worker is restarted, a stopped one included: try-restart left a stopped worker stopped, and
# the factory ran fewer tasks at once without anyone noticing. The enabled ones are what the boot target
# wants (install-services.sh enables FACTORY_WORKERS of them). The feeder opens issues in real repositories,
# so it is started on purpose, never here: try-restart restarts it only when it already runs.
mapfile -t workers < <(systemctl --user list-dependencies --plain --no-legend default.target |
  grep -oE 'aifactory-worker@[0-9]+\.service' | sort -u)
systemctl --user restart aifactory.service &
pids=($!)
if [ "${#workers[@]}" -gt 0 ]; then
  systemctl --user restart --no-block "${workers[@]}" &
  pids+=($!)
fi
systemctl --user try-restart aifactory-feeder.service &
pids+=($!)
for pid in "${pids[@]}"; do wait "$pid"; done
for _ in $(seq 1 40); do
  curl -fs -o /dev/null http://127.0.0.1:3000/api/health && { echo "aifactory is up"; exit 0; }
  sleep 1
done
echo "aifactory did not answer on :3000" >&2
journalctl --user -u aifactory.service -n 30 --no-pager >&2
exit 1

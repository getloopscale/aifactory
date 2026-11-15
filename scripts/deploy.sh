#!/usr/bin/env bash
# Builds and restarts the service, the workers and the feeder, then waits for the server to answer. The
# tunnel is not touched.
#
# A restart does not cut the runs in progress: systemd signals theokit only (KillMode=mixed), which stops
# taking jobs, waits for the run it is on (up to 92 minutes, see src/server/factory/drain.ts) and exits.
# So a deploy while tasks work takes as long as the longest of them.
set -euo pipefail
cd "$(dirname "$0")/.."

working="select count(*) from task where stage in ('sandbox','build','push','verify','review','pr')"
if busy=$(docker compose exec -T postgres psql -U factory -d factory -At -c "$working" 2>/dev/null); then
  if [ "$busy" != "0" ]; then
    echo "$busy task(s) are working; the restart waits for them to finish (up to 92 minutes)." >&2
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

# The check reads tables the release may have changed, so the migrations come first. A failure stops the
# deploy before anything is built or restarted.
if ! pnpm db:migrate; then
  echo "the migrations failed (see above); nothing was built or restarted" >&2
  exit 1
fi

# When a prompt, an agent or a model changed since evals/baseline.json, the quick cases run again on real
# agents and must do no worse than the baseline (docs/adr/0008). Nothing changed, nothing runs.
if ! pnpm evals:check; then
  echo "the agents did worse than the baseline (see above); nothing was built or restarted" >&2
  exit 1
fi

# The installed units are copies, so a release that changes one reaches them here. Only the files are written
# and systemd reloaded: nothing is enabled or disabled, so a unit the owner turned off stays off. It runs before
# the restart, after a build that succeeded, so a failed build leaves the installed units as they were.
pnpm build
scripts/write-units.sh
systemctl --user daemon-reload
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
  systemctl --user restart "${workers[@]}" &
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

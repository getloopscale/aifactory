#!/usr/bin/env bash
# Writes the unit files of ops/systemd into ~/.config/systemd/user, with the paths of this machine filled in.
# It runs no systemctl: it enables, disables and reloads nothing. install-services.sh and deploy.sh call it.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$HOME/.config/systemd/user"
mkdir -p "$dest"
cloudflared="$(command -v cloudflared || true)"
# Without cloudflared on this PATH, the path the installed tunnel unit already names is used, whether or not it still
# runs; with neither, that unit cannot be rendered and is left as it is with a line on stderr (unless it is
# enabled: then nothing is written and the script fails), so a missing cloudflared never keeps the other services from deploying.
if [ -z "$cloudflared" ] && [ -f "$dest/aifactory-tunnel.service" ]; then
  candidate="$(sed -n 's/^ExecStart=\([^ ]*cloudflared\) .*/\1/p' "$dest/aifactory-tunnel.service" | head -n 1)"
  if [ -n "$candidate" ]; then cloudflared="$candidate"; fi
fi
# The tunnel unit needs cloudflared. When none is found and that unit is enabled, nothing is written: the caller
# stops, and the message names cloudflared. --check only decides that, so deploy.sh can stop before it builds.
if [ -z "$cloudflared" ] && systemctl --user is-enabled --quiet aifactory-tunnel.service 2>/dev/null; then
  echo "cloudflared is not on PATH and no installed one runs, and aifactory-tunnel.service is enabled; no unit was written" >&2
  exit 1
fi
if [ "${1:-}" = "--check" ]; then exit 0; fi
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
for unit in "$root"/ops/systemd/*; do
  name="$(basename "$unit")"
  if [ -z "$cloudflared" ] && grep -q '@CLOUDFLARED@' "$unit"; then
    echo "cloudflared is not on PATH and no installed one runs; $name was not written and is left as it is" >&2
    continue
  fi
  sed -e "s#@ROOT@#$root#g" -e "s#@HOME@#$HOME#g" -e "s#@NODE_BIN@#$(dirname "$(command -v node)")#g" \
    -e "s#@CLOUDFLARED@#$cloudflared#g" "$unit" > "$staging/$name"
done
cp "$staging"/* "$dest"/

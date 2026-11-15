#!/usr/bin/env bash
# Writes the unit files of ops/systemd into ~/.config/systemd/user, with the paths of this machine filled in.
# It runs no systemctl: it enables, disables and reloads nothing. install-services.sh and deploy.sh call it.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$HOME/.config/systemd/user"
mkdir -p "$dest"
cloudflared="$(command -v cloudflared || true)"
# Without cloudflared on this PATH, the executable the installed tunnel unit already names is used when it still
# runs; with neither, that unit cannot be rendered and is skipped with a warning (an installed copy stays as it
# is), so a missing cloudflared never keeps the other services from deploying.
if [ -z "$cloudflared" ] && [ -f "$dest/aifactory-tunnel.service" ]; then
  candidate="$(sed -n 's/^ExecStart=\([^ ]*cloudflared\) .*/\1/p' "$dest/aifactory-tunnel.service" | head -n 1)"
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then cloudflared="$candidate"; fi
fi
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
for unit in "$root"/ops/systemd/*; do
  name="$(basename "$unit")"
  if [ -z "$cloudflared" ] && grep -q '@CLOUDFLARED@' "$unit"; then
    echo "cloudflared is not on PATH and no installed one runs; $name was not written" >&2
    continue
  fi
  sed -e "s#@ROOT@#$root#g" -e "s#@HOME@#$HOME#g" -e "s#@NODE_BIN@#$(dirname "$(command -v node)")#g" \
    -e "s#@CLOUDFLARED@#$cloudflared#g" "$unit" > "$staging/$name"
done
cp "$staging"/* "$dest"/

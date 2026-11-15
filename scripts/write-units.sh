#!/usr/bin/env bash
# Writes the unit files of ops/systemd into ~/.config/systemd/user, with the paths of this machine filled in.
# It runs no systemctl: it enables, disables and reloads nothing. install-services.sh and deploy.sh call it.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$HOME/.config/systemd/user"
mkdir -p "$dest"
cloudflared="$(command -v cloudflared || true)"
# Without cloudflared on this PATH a unit that runs it cannot be rendered. It fails before any unit is
# written, installed or not: keeping an old copy would leave the release's changes out of it unseen.
if [ -z "$cloudflared" ]; then
  for unit in "$root"/ops/systemd/*; do
    if grep -q '@CLOUDFLARED@' "$unit"; then
      echo "cloudflared is not on PATH; cannot write $(basename "$unit")" >&2
      exit 1
    fi
  done
fi
for unit in "$root"/ops/systemd/*; do
  name="$(basename "$unit")"
  sed -e "s#@ROOT@#$root#g" -e "s#@HOME@#$HOME#g" -e "s#@NODE_BIN@#$(dirname "$(command -v node)")#g" \
    -e "s#@CLOUDFLARED@#$cloudflared#g" "$unit" > "$dest/$name"
done

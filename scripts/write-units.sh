#!/usr/bin/env bash
# Writes the unit files of ops/systemd into ~/.config/systemd/user, with the paths of this machine filled in.
# It runs no systemctl: it enables, disables and reloads nothing. install-services.sh and deploy.sh call it.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$HOME/.config/systemd/user"
mkdir -p "$dest"
cloudflared="$(command -v cloudflared || true)"
for unit in "$root"/ops/systemd/*; do
  name="$(basename "$unit")"
  # Without cloudflared on this PATH a unit that runs it cannot be rendered. An installed copy stays as it is,
  # since it may have been made with another PATH; with none installed there is nothing to keep, so it fails.
  if [ -z "$cloudflared" ] && grep -q '@CLOUDFLARED@' "$unit"; then
    if [ -f "$dest/$name" ]; then
      echo "cloudflared is not on PATH; $name was left as installed" >&2
      continue
    fi
    echo "cloudflared is not on PATH and $name is not installed; cannot write it" >&2
    exit 1
  fi
  sed -e "s#@ROOT@#$root#g" -e "s#@HOME@#$HOME#g" -e "s#@NODE_BIN@#$(dirname "$(command -v node)")#g" \
    -e "s#@CLOUDFLARED@#$cloudflared#g" "$unit" > "$dest/$name"
done

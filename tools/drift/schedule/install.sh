#!/bin/bash
# Install the weekly drift launchd agent (com.kbstudio.drift-weekly). Installed DISABLED by default:
# the plist is written to ~/Library/LaunchAgents and marked disabled in launchd, but not loaded.
#
#   tools/drift/schedule/install.sh                 # write plist, keep disabled (default; dry-run submits)
#   tools/drift/schedule/install.sh --live          # scheduled runs really create jobs + post to Slack
#   tools/drift/schedule/install.sh --enable [...]  # also enable + load it (starts firing on schedule)
#   other options are passed to render-plist.mjs: --weekday 1 --hour 6 --minute 0 --port 8787
set -euo pipefail
LABEL=com.kbstudio.drift-weekly
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
NODE="${NODE:-$(command -v node || echo /opt/homebrew/bin/node)}"
ENABLE=0
ARGS=()
for a in "$@"; do
  if [ "$a" = "--enable" ]; then ENABLE=1; else ARGS+=("$a"); fi
done

TMP="$(mktemp "${TMPDIR:-/tmp}/$LABEL.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
"$NODE" "$HERE/render-plist.mjs" ${ARGS[@]+"${ARGS[@]}"} > "$TMP"
plutil -lint "$TMP" >/dev/null

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
mkdir -p "$HOME/Library/LaunchAgents"
install -m 0644 "$TMP" "$DEST"

if [ "$ENABLE" = 1 ]; then
  launchctl enable "$DOMAIN/$LABEL"
  launchctl bootstrap "$DOMAIN" "$DEST"
  echo "installed and ENABLED: $DEST"
else
  launchctl disable "$DOMAIN/$LABEL"
  echo "installed DISABLED (not loaded): $DEST"
  echo "enable later with: $HERE/install.sh --enable   (or: launchctl enable $DOMAIN/$LABEL && launchctl bootstrap $DOMAIN $DEST)"
fi
grep -q '&quot;dryRun&quot;:true' "$DEST" && echo "scheduled submits are DRY RUNS (re-run with --live to post real jobs)" || echo "scheduled submits are LIVE"

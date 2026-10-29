#!/bin/bash
# Remove the weekly drift launchd agent: unload it (if loaded) and delete the plist.
# The launchd "disabled" override for the label is left in place (harmless; install.sh --enable clears it).
set -euo pipefail
LABEL=com.kbstudio.drift-weekly
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$DEST"
echo "removed $LABEL ($DEST)"

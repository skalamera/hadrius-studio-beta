#!/bin/bash
# Hadrius Studio Beta — update script.
# Pulls the latest code (converting a zip-installed folder into a real git clone
# if needed), reruns setup.sh to pick up new dependencies and restart the
# background bridge, and reminds you about the one step it can't automate.
set -euo pipefail
cd "$(dirname "$0")"

OS="$(uname -s)"
REPO_URL="https://github.com/skalamera/hadrius-studio-beta.git"

echo "=== Updating Hadrius Studio Beta ==="

# 0. Ensure git is installed
if ! command -v git >/dev/null; then
  echo "Git not found. Installing..."
  if [[ "$OS" == "Darwin" ]]; then
    if command -v brew >/dev/null; then
      brew install git
    else
      echo "Triggering the Xcode Command Line Tools installer (this includes git)..."
      xcode-select --install 2>/dev/null || true
      echo "Complete the install dialog on your screen, then re-run this script."
      exit 1
    fi
  elif [[ "$OS" == "Linux" ]]; then
    sudo apt-get update && sudo apt-get install -y git
  else
    echo "Unsupported OS for automatic git install. Install git manually, then re-run this script." >&2
    exit 1
  fi
fi
echo "✓ git $(git --version | awk '{print $3}') is ready."

# 1. Safety net: back up the whole folder before touching anything, in case this
# is a zip install with local edits (e.g. data/manual-links.json) that were
# never pushed anywhere. Skips the big reinstallable directories to stay small.
BACKUP="../hadrius-studio-beta-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
echo "Backing up current folder to $BACKUP (in case anything needs to be recovered)..."
tar --exclude='./node_modules' --exclude='./.venv' --exclude='./out' --exclude='./.git' -czf "$BACKUP" . 2>/dev/null || true
echo "✓ Backup saved."

# 2. Pull the latest code — or, if this folder came from the distributed zip and
# has no git history yet, convert it into a real clone of the repo first.
if [[ -d .git ]]; then
  echo "Existing git repository detected — pulling latest changes..."
  STASHED=0
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Stashing local changes to tracked files before pulling..."
    git stash push -u -m "update.sh auto-stash $(date -u +%FT%TZ)"
    STASHED=1
  fi
  git fetch origin main
  git checkout main
  git pull origin main
  if [[ "$STASHED" == "1" ]]; then
    echo "Restoring your local changes..."
    git stash pop || echo "⚠ Could not auto-restore local changes — run 'git stash list' and 'git stash pop' manually, or recover them from $BACKUP."
  fi
else
  echo "This folder has no git history (likely installed from a zip) — converting it into a git clone in place..."
  git init -q
  git remote add origin "$REPO_URL"
  git fetch origin main
  # -f overwrites tracked files with origin/main's versions; untracked/gitignored
  # files (like .env) are left alone. The tar backup above covers anything tracked
  # that only existed locally (e.g. manual-links.json entries never synced upstream).
  git checkout -f -B main origin/main
fi
echo "✓ Now on the latest commit: $(git log -1 --format='%h %s')"

# 3. Reinstall dependencies and restart the background bridge with the new code.
echo
echo "Re-running setup.sh (installs anything new, restarts the bridge)..."
bash setup.sh

cat <<'EOF'

===================================================================
✓ Update complete.

One manual step this script can't do for you:
  Open chrome://extensions, find Hadrius Studio, and click the
  reload icon (⟳) so the browser picks up the extension changes.
===================================================================
EOF

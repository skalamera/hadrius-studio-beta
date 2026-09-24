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

# Sanity check: this script updates whatever folder IT lives in (same rule as
# setup.sh), not whatever folder you happened to run it from. If someone drops
# it into ~/Downloads and runs it there without moving it into their existing
# install first, refuse rather than silently git-initing a stray clone into a
# random directory — that would also steal port 8787 from their real bridge
# when setup.sh runs.
if [[ ! -f extension/manifest.json && -n "$(ls -A . 2>/dev/null)" ]]; then
  echo "This doesn't look like a Hadrius Studio Beta folder (no extension/manifest.json)," >&2
  echo "and the current folder ($(pwd)) isn't empty either." >&2
  echo >&2
  echo "update.sh updates whatever folder it's placed in — move it into your" >&2
  echo "existing install and run it from there, e.g.:" >&2
  echo "  mv ~/Downloads/update.sh ~/hadrius-studio-beta/" >&2
  echo "  cd ~/hadrius-studio-beta && bash update.sh" >&2
  exit 1
fi

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

  # Runtime data the bridge rewrites all day (workflow plans, done/dismissed marks, progress).
  # These used to be tracked in git, so every pull collided with the local copy — and a failed
  # stash pop left them mid-merge, which then made every later `git stash` die with "needs merge
  # / could not write index". Set them aside before git runs and put them back after: local state
  # wins, and the bridge re-syncs with the shared library anyway. A copy that's no longer valid
  # JSON (conflict markers from an old failed merge) is dropped so the bridge rebuilds it instead.
  RUNTIME_DATA=(data/workflows.json data/manual-links.json data/dismissed-workflows.json data/enhance-progress.json data/bulk_record_progress.json)
  DATA_SAVE="$(mktemp -d)"
  for f in "${RUNTIME_DATA[@]}"; do
    if [[ -f "$f" ]]; then
      if ! command -v python3 >/dev/null || python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$f" 2>/dev/null; then
        mkdir -p "$DATA_SAVE/$(dirname "$f")" && cp "$f" "$DATA_SAVE/$f"
      else
        echo "⚠ $f was unreadable (left over from an earlier failed merge) — the bridge will rebuild it from the shared library."
      fi
    fi
    if git ls-files --error-unmatch "$f" >/dev/null 2>&1 || git ls-files -u -- "$f" | grep -q .; then
      git reset -q -- "$f" 2>/dev/null || true      # clears a stuck "needs merge" entry for it
      git checkout -q -- "$f" 2>/dev/null || true   # and drops its local edits (saved above)
    fi
  done
  # A merge left half-done (MERGE_HEAD) blocks every pull. The backup above covers anything it held.
  if [[ -f .git/MERGE_HEAD ]]; then
    echo "Abandoning an unfinished merge from an earlier update (your files are in $BACKUP)..."
    git merge --abort 2>/dev/null || git reset -q --merge 2>/dev/null || true
  fi
  UNMERGED="$(git diff --name-only --diff-filter=U)"
  if [[ -n "$UNMERGED" ]]; then
    echo "These files are stuck mid-merge from an earlier update, so git can't pull:" >&2
    echo "$UNMERGED" | sed 's/^/  /' >&2
    echo "If you didn't edit them yourself, discard them and re-run:  git reset -q && git checkout -- <file>" >&2
    echo "(Everything is also backed up in $BACKUP.)" >&2
    exit 1
  fi

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
  for f in "${RUNTIME_DATA[@]}"; do
    [[ -f "$DATA_SAVE/$f" ]] && cp "$DATA_SAVE/$f" "$f"
  done
  rm -rf "$DATA_SAVE"
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

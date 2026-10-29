#!/bin/bash
# Hadrius Studio installer: the worker behind "Install Hadrius Studio.app".
#
# installer/build.sh bundles this script with team.env (the shared team credentials) into the app.
# The app's AppleScript only shows dialogs and a progress window; everything real happens here, so a
# failed install can be re-run from Terminal to see exactly what went wrong:
#   bash "Install Hadrius Studio.app/Contents/Resources/install.sh" install /tmp/hs-install
#
# Modes:
#   install <stateDir>        install, or update an existing install, writing progress to <stateDir>
#   chrome-status <extDir> [oldExtDir]
#                             key=value lines: is that unpacked extension loaded in Chrome? (read-only)
#                             oldExtDir: a folder Studio was moved out of, reported as old= if still loaded
#   claude-signin <stateDir>  open a Terminal window that signs Claude + the codebase MCP in
#
# <stateDir>/status is one tab-separated line: <percent> <state> <title> <detail>, where state is
# running | done | error. All output goes to <stateDir>/install.log. After a successful install,
# <stateDir>/install-dir holds the install folder, checks holds key=value service checks and warnings
# holds a human-readable list of anything that isn't connected.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_URL="${HS_REPO_URL:-https://github.com/skalamera/hadrius-studio-beta.git}"
DEFAULT_DIR="$HOME/hadrius-studio-beta"
BRIDGE_URL="http://127.0.0.1:8787"
PLIST="$HOME/Library/LaunchAgents/com.kbstudio.aibridge.plist"
ENV_MARKER="# --- Hadrius Studio team credentials (written by the installer; run it again to refresh) ---"

# Apps opened from Finder get a bare PATH: add every place setup.sh may have put node/claude/ffmpeg.
export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export LANG="${LANG:-en_US.UTF-8}"

STATE_DIR=""

status() { # status <percent> <state> <title> [detail]
  [[ -n "$STATE_DIR" ]] || return 0
  local detail="${4:-}"
  detail="${detail//$'\t'/ }"
  detail="${detail//$'\r'/}"
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "${detail:0:300}" > "$STATE_DIR/status.tmp" \
    && mv -f "$STATE_DIR/status.tmp" "$STATE_DIR/status"
}

fail() { # fail <title> [detail]
  echo "ERROR: $1${2:+ ($2)}"
  status 100 error "$1" "${2:-}"
  exit 1
}

# ---- Apple's Command Line Tools: git (to download Studio) and python3 (for setup.sh) -------------
clt_ready() {
  local dev
  dev="$(xcode-select -p 2>/dev/null)" || return 1
  [[ -x "$dev/usr/bin/git" && -x "$dev/usr/bin/python3" ]]
}

ensure_clt() {
  clt_ready && return 0
  echo "Command Line Tools are missing; asking macOS to install them."
  xcode-select --install >/dev/null 2>&1 || true
  local waited=0 idle=0
  until clt_ready; do
    status 6 running "Installing Apple's developer tools…" \
      "Click “Install” in the macOS window, then wait. This download takes 5 to 15 minutes ($((waited / 60)) min so far)."
    sleep 5
    waited=$((waited + 5))
    # Apple's window was closed without installing: open it again (never re-run the git/python3
    # shims to check, they'd pop the same window every few seconds).
    if pgrep -f "Install Command Line Developer Tools" >/dev/null 2>&1; then idle=0; else idle=$((idle + 5)); fi
    if (( idle >= 60 )); then
      xcode-select --install >/dev/null 2>&1 || true
      idle=0
    fi
    (( waited < 3600 )) || fail "Apple's developer tools didn't finish installing." \
      "Run the installer again and click “Install” when macOS asks about the command line developer tools."
  done
  echo "✓ Command Line Tools installed."
}

# ---- Where Studio lives: an existing install (wherever its background service points), else ~ ----
existing_dir() {
  local dir
  dir="$(service_dir)" || return 1
  [[ -f "$dir/extension/manifest.json" && -f "$dir/setup.sh" ]] || return 1
  printf '%s\n' "$dir"
}

# The folder the background service runs from, whether or not it still exists.
service_dir() {
  [[ -f "$PLIST" ]] || return 1
  local bridge dir
  bridge="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:1' "$PLIST" 2>/dev/null)" || return 1
  dir="${bridge%/tools/ai-bridge.mjs}"
  [[ "$dir" != "$bridge" ]] || return 1
  printf '%s\n' "$dir"
}

# ---- Installs in ~/Downloads (unzipped there and never moved) break when Downloads gets cleaned up,
# and macOS privacy rules can block background services from reading it. Move them to the home
# folder. Sets RELOCATED_DIR to the new folder, or leaves it empty when the Downloads copy is already
# gone (fresh install). Not called in $(...): fail must exit the installer, not a subshell.
RELOCATED_DIR=""
relocate_from_downloads() { # relocate_from_downloads <oldDir>
  local old="$1" target n=2
  # Reading Downloads needs the user's OK (macOS asks once). Without it every check below would
  # wrongly say "not there", so stop and ask instead.
  if ! ls "$HOME/Downloads" >/dev/null 2>&1; then
    fail "macOS didn't let the installer open your Downloads folder." \
      "Hadrius Studio is installed there and needs moving. Run the installer again and click OK when macOS asks about Downloads."
  fi
  if [[ ! -f "$old/extension/manifest.json" || ! -f "$old/setup.sh" ]]; then
    echo "The service points at $old, which is gone; installing a fresh copy instead."
    return 0
  fi
  if [[ -d "$old/.git" ]]; then
    local changed
    changed="$(local_code_changes "$old")"
    [[ -z "$changed" ]] || fail "This copy of Hadrius Studio has local code changes, so the installer left it alone." \
      "$old: $(printf '%s' "$changed" | head -3 | paste -sd' ' -)"
  fi
  # Never overwrite: an older ~/hadrius-studio-beta (an abandoned copy) gets a numbered sibling.
  target="$DEFAULT_DIR"
  while [[ -e "$target" ]]; do target="$DEFAULT_DIR-$n"; n=$((n + 1)); done
  status 12 running "Moving Hadrius Studio out of your Downloads folder…" "to $target"
  echo "Moving $old -> $target"
  mv "$old" "$target" || fail "Couldn't move Hadrius Studio out of your Downloads folder." \
    "Quit Chrome and run the installer again."
  # A venv's scripts hard-code the folder they were created in (pip would fail with "bad
  # interpreter"); setup.sh rebuilds it in under a minute.
  rm -rf "$target/.venv"
  RELOCATED_DIR="$target"
  echo "✓ Moved to $target"
}

# Tracked files edited by hand. The bridge rewrites data/ and npm rewrites package-lock.json on its
# own, so those don't count; anything else means a developer copy the installer must not touch.
local_code_changes() {
  git -C "$1" status --porcelain --untracked-files=no 2>/dev/null | cut -c4- \
    | grep -vE '^(data/|package-lock\.json$)' || true
}

# ---- .env: the team keys from team.env replace the same keys in .env; every other line is kept ----
merge_env() { # merge_env <team.env> <.env>
  local src="$1" dst="$2" keys pattern tmp
  keys="$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$src" | cut -d= -f1 | sort -u)"
  [[ -n "$keys" ]] || return 1
  pattern="^($(printf '%s\n' "$keys" | paste -sd'|' -))="
  touch "$dst" || return 1
  tmp="$(mktemp "$dst.XXXXXX")" || return 1
  { grep -vE "$pattern" "$dst" | grep -vxF "$ENV_MARKER" || true; } > "$tmp"
  # .env files written by hand often lack a final newline; appending would glue two keys together.
  if [[ -s "$tmp" && -n "$(tail -c1 "$tmp")" ]]; then printf '\n' >> "$tmp"; fi
  { printf '%s\n' "$ENV_MARKER"; grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$src"; } >> "$tmp"
  chmod 600 "$tmp" && mv -f "$tmp" "$dst"
}

# ---- Run setup.sh / update.sh, logging every line and turning known lines into progress -----------
run_logged() { # run_logged <cmd...>
  "$@" </dev/null 2>&1 | {
    pct=30
    title="Installing…"
    while IFS= read -r line; do
      printf '%s\n' "$line"
      line="${line##*$'\r'}"
      case "$line" in
        *"Backing up current folder"*) pct=27; title="Backing up your current copy…" ;;
        *"pulling latest changes"* | *"converting it into a git clone"*) pct=29; title="Downloading the latest version…" ;;
        *"Now on the latest commit"*) pct=31; title="Downloaded the latest version" ;;
        *"Setting up Hadrius Studio"*) pct=32; title="Checking your Mac's tools…" ;;
        *"Node.js not found"*) pct=34; title="Installing Node.js…" ;;
        *"✓ Node.js"*) pct=37; title="Checking Python…" ;;
        *"✓ Python 3"*) pct=39; title="Checking Google Chrome…" ;;
        *"Google Chrome not found"* | *"Downloading official Google Chrome"*) pct=40; title="Installing Google Chrome…" ;;
        *"✓ Google Chrome"*) pct=44; title="Checking the video tools (FFmpeg)…" ;;
        *"FFmpeg/FFprobe not found"*) pct=45; title="Installing the video tools (FFmpeg)…" ;;
        *"✓ FFmpeg"* | *"FFmpeg/FFprobe could not be verified"*) pct=50; title="Checking the Claude CLI…" ;;
        *"Claude CLI not found"*) pct=51; title="Installing the Claude CLI…" ;;
        *"✓ Claude CLI"*) pct=55; title="Setting things up…" ;;
        *"Creating Python virtual environment"* | *"Installing Python dependencies"*) pct=58; title="Installing Python packages…" ;;
        *"Installing Node dependencies"*) pct=65; title="Installing Node packages…" ;;
        *"Installing Playwright Chromium"*) pct=70; title="Downloading the recording browser (about 150 MB)…" ;;
        *"Verifying Playwright"*) pct=86; title="Starting the background service…" ;;
        *"Installed background bridge service"*) pct=90; title="Starting the background service…" ;;
        *"Bridge is running"* | *"Bridge started but"*) pct=93; title="Checking the connections…" ;;
      esac
      line="${line#"${line%%[![:space:]]*}"}"
      [[ -n "$line" ]] && status "$pct" running "$title" "$line"
    done
  }
  return "${PIPESTATUS[0]}"
}

# ---- After setup: is the background service up, and do the team credentials actually work? -------
check_services() { # check_services <installDir>
  local health="" tools library i
  for i in $(seq 1 40); do
    health="$(curl -s --max-time 3 "$BRIDGE_URL/health" 2>/dev/null || true)"
    [[ "$health" == *'"ok":true'* ]] && break
    sleep 1
  done
  [[ "$health" == *'"ok":true'* ]] || return 1
  tools="$(curl -s --max-time 90 "$BRIDGE_URL/status/tools?fresh=1" 2>/dev/null || true)"
  # /health only says a library secret is present; listing the library proves it's accepted.
  library="$(curl -s --max-time 30 "$BRIDGE_URL/library" 2>/dev/null | head -c 200 || true)"
  /usr/bin/python3 - "$tools" "$library" "$STATE_DIR" <<'PY'
import json, os, sys
tools, library, state = sys.argv[1:4]
try:
    t = json.loads(tools)
except Exception:
    t = {}
checks = {"library": library.startswith('{"ok":true')}
for k in ("claude", "codebase", "drive", "pylon"):
    checks[k] = bool((t.get(k) or {}).get("connected"))
# Claude and the codebase MCP are personal sign-ins, offered right after this; everything else
# comes from the team credentials, so a failure there is worth telling Stephen about.
labels = {"library": "Shared team library", "pylon": "Pylon", "drive": "Google Drive"}
warnings = []
for k, label in labels.items():
    if not checks[k]:
        detail = (t.get(k) or {}).get("detail") or ("couldn't reach it" if k == "library" else "not connected")
        warnings.append(f"• {label}: {str(detail)[:140]}")
with open(os.path.join(state, "checks"), "w") as f:
    f.write("".join(f"{k}={int(v)}\n" for k, v in checks.items()))
with open(os.path.join(state, "warnings"), "w") as f:
    f.write("\n".join(warnings))
print("Service checks: " + ", ".join(f"{k}={'ok' if v else 'NOT CONNECTED'}" for k, v in checks.items()))
for w in warnings:
    print("WARNING " + w)
PY
}

do_install() {
  STATE_DIR="$1"
  mkdir -p "$STATE_DIR" || exit 1
  local log="$STATE_DIR/install.log"
  if [[ -f "$log" ]] && (( $(stat -f %z "$log" 2>/dev/null || echo 0) > 5000000 )); then mv -f "$log" "$log.old"; fi
  exec >>"$log" 2>&1
  rm -f "$STATE_DIR/checks" "$STATE_DIR/warnings" "$STATE_DIR/install-dir" "$STATE_DIR/moved-from"
  echo $$ > "$STATE_DIR/pid"
  trap 'rm -f "$STATE_DIR/pid"' EXIT
  trap 'echo "Stopped."; status 100 error "Installation stopped." ""; exit 130' TERM INT

  echo
  echo "===== Hadrius Studio install $(date '+%Y-%m-%d %H:%M:%S'): macOS $(sw_vers -productVersion) $(uname -m), user $(id -un) ====="
  status 2 running "Getting ready…" ""

  local team_env="$HERE/team.env"
  [[ -f "$team_env" ]] || fail "This installer is missing its team settings." "Ask Stephen for a fresh copy of the installer."

  ensure_clt
  status 10 running "Getting ready…" ""

  if curl -s --max-time 3 "$BRIDGE_URL/render/status" 2>/dev/null | grep -q '"running":true'; then
    fail "A video is rendering right now." "Run the installer again when the render finishes."
  fi

  local dir mode svc
  svc="$(service_dir || true)"
  if [[ "$svc" == "$HOME/Downloads/"* ]]; then
    # The Chrome step uses this to spot the old copy's card (its folder no longer exists).
    printf '%s\n' "$svc/extension" > "$STATE_DIR/moved-from"
    relocate_from_downloads "$svc"
    dir="$RELOCATED_DIR"
  else
    dir="$(existing_dir || true)"
  fi
  [[ -n "$dir" ]] || dir="$DEFAULT_DIR"
  if [[ -f "$dir/extension/manifest.json" && -f "$dir/setup.sh" ]]; then
    mode=update
    echo "Existing install found at $dir; updating it in place."
    if [[ -d "$dir/.git" ]]; then
      local changed
      changed="$(local_code_changes "$dir")"
      [[ -z "$changed" ]] || fail "This copy of Hadrius Studio has local code changes, so the installer left it alone." \
        "$dir: $(printf '%s' "$changed" | head -3 | paste -sd' ' -)"
    fi
  elif [[ -e "$dir" && -n "$(ls -A "$dir" 2>/dev/null)" ]]; then
    fail "A folder named $(basename "$dir") is already in your home folder." \
      "It isn't Hadrius Studio. Rename or remove it, then run the installer again."
  else
    mode=fresh
    status 15 running "Downloading Hadrius Studio…" ""
    echo "Cloning $REPO_URL into $dir"
    git clone --quiet "$REPO_URL" "$dir" || fail "Couldn't download Hadrius Studio." \
      "Check your internet connection, then run the installer again."
  fi

  status 24 running "Connecting the team's accounts…" ""
  merge_env "$team_env" "$dir/.env" || fail "Couldn't write the settings file." "$dir/.env"
  echo "✓ Team credentials written to $dir/.env: $(grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' "$team_env" | tr -d '=' | paste -sd' ' -)"

  cd "$dir" || fail "Couldn't open $dir."
  status 26 running "Installing…" ""
  if [[ "$mode" == update ]]; then
    run_logged bash update.sh || fail "The update didn't finish." "See the log for details."
  else
    run_logged bash setup.sh || fail "Setup didn't finish." "See the log for details."
  fi

  status 95 running "Checking the connections…" ""
  check_services "$dir" || fail "Hadrius Studio's background service didn't start." \
    "Restart your Mac and run the installer again. If it still fails, send Stephen the log."

  printf '%s\n' "$dir" > "$STATE_DIR/install-dir"
  echo "✓ Install finished: $dir"
  status 100 done "Hadrius Studio is installed." "$dir"
}

# ---- Chrome: read each profile's Secure Preferences (unpacked extensions + Developer mode live there).
# Chrome writes this file a few seconds after a change, so callers poll.
do_chrome_status() {
  /usr/bin/python3 - "$1" "${2:-}" <<'PY'
import glob, json, os, sys
ext = os.path.realpath(sys.argv[1])
moved_from = os.path.realpath(sys.argv[2]) if sys.argv[2] else None
base = os.path.expanduser("~/Library/Application Support/Google/Chrome")
chrome = any(os.path.isdir(p) for p in ("/Applications/Google Chrome.app", os.path.expanduser("~/Applications/Google Chrome.app")))
loaded = disabled = devmode = False
old = ""
profiles = 0
for prefs in sorted(glob.glob(os.path.join(base, "*", "Secure Preferences"))):
    if os.path.basename(os.path.dirname(prefs)) in ("System Profile", "Guest Profile"):
        continue
    try:
        with open(prefs, encoding="utf-8") as f:
            d = json.load(f)
    except Exception:
        continue
    profiles += 1
    exts = d.get("extensions") or {}
    if (exts.get("ui") or {}).get("developer_mode"):
        devmode = True
    for s in (exts.get("settings") or {}).values():
        if not isinstance(s, dict) or s.get("location") != 4 or not s.get("path"):  # 4 = unpacked
            continue
        off = bool(s.get("disable_reasons")) or s.get("state") == 0
        if os.path.realpath(s["path"]) == ext:
            loaded = loaded or not off
            disabled = disabled or off
            continue
        # A moved copy's folder is gone, so its manifest can't be read: match it by its old path.
        if moved_from and os.path.realpath(s["path"]) == moved_from:
            old = old or s["path"]
            continue
        try:
            with open(os.path.join(s["path"], "manifest.json"), encoding="utf-8") as f:
                name = json.load(f).get("name", "")
        except Exception:
            name = ""
        if name == "Hadrius Studio" and not old:
            old = s["path"]
print(f"chrome={int(chrome)}")
print(f"profiles={profiles}")
print(f"devmode={int(devmode)}")
print(f"loaded={int(loaded)}")
print(f"disabled={int(disabled and not loaded)}")
print(f"old={old}")
PY
}

# ---- Claude: a personal sign-in (each person's own seat), so it can't ship in team.env. It needs a
# real terminal, so write a .command file and open it: Terminal shows progress, the browser does the rest.
do_claude_signin() {
  local dir="$1" f
  mkdir -p "$dir" || exit 1
  f="$dir/Sign in to Claude.command"
  cat > "$f" <<EOF
#!/bin/bash
# Signs this Mac's Claude CLI in for Hadrius Studio. Written by the Hadrius Studio installer.
export PATH="$PATH"
clear
echo "Signing in to Claude for Hadrius Studio"
echo "======================================="
echo
if ! command -v claude >/dev/null; then
  echo "The Claude CLI isn't installed yet. Run the Hadrius Studio installer first."
  exit 1
fi
if claude auth status 2>/dev/null | grep -q '"loggedIn": *true'; then
  echo "✓ Claude is already signed in."
else
  echo "Your browser will open. Sign in there with your Hadrius account, then come back here."
  echo
  claude auth login
fi
echo
if claude mcp get hadrius-codebase 2>&1 | grep -qi 'No MCP server named'; then
  claude mcp add --transport http hadrius-codebase https://mcp.hadriusapi.com/codebase --scope user >/dev/null 2>&1 || true
fi
mcp="\$(claude mcp get hadrius-codebase 2>&1)"
if printf '%s' "\$mcp" | grep -qiE '✔|connected' && ! printf '%s' "\$mcp" | grep -qiE '✗|✘|failed|disconnected|needs authentication'; then
  echo "✓ The Hadrius codebase is connected."
else
  echo "Connecting the Hadrius codebase. Your browser may open again."
  echo
  claude mcp login hadrius-codebase
fi
echo
echo "All done. You can close this window."
EOF
  chmod +x "$f"
  xattr -d com.apple.quarantine "$f" 2>/dev/null || true
  open "$f"
}

case "${1:-}" in
  install) do_install "${2:?usage: install.sh install <stateDir>}" ;;
  chrome-status) do_chrome_status "${2:?usage: install.sh chrome-status <extensionDir> [oldExtensionDir]}" "${3:-}" ;;
  claude-signin) do_claude_signin "${2:?usage: install.sh claude-signin <stateDir>}" ;;
  *)
    echo "usage: install.sh install <stateDir> | chrome-status <extensionDir> | claude-signin <stateDir>" >&2
    exit 2
    ;;
esac

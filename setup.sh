#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

# Migrate credentials from an existing Hadrius Studio installation.
if [[ ! -f .env ]]; then
  for candidate in "$HOME/kb-studio/.env" "$HOME/hadrius-studio/.env" "../hadrius-studio/.env"; do
    if [[ -f "$candidate" ]]; then
      echo "Migrating existing credentials from $candidate..."
      cp "$candidate" .env
      break
    fi
  done
  [[ ! -f .env && -f .env.example ]] && cp .env.example .env
fi

command -v node >/dev/null || { echo 'Node 20+ is required.' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'Python 3 is required.' >&2; exit 1; }
command -v ffmpeg >/dev/null || echo 'Warning: FFmpeg is required to render MP4 files.'
if ! command -v gemini >/dev/null; then
  echo 'Installing Gemini CLI (temporary primary AI provider)...'
  npm install -g @google/gemini-cli
fi
command -v claude >/dev/null || echo 'Warning: Claude CLI is unavailable; temporary fallback will be disabled.'

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(command -v node)"
NODE_DIR="$(dirname "$NODE_BIN")"

if ! gemini mcp list 2>/dev/null | grep -q 'hadrius-codebase'; then
  gemini mcp add --transport http --scope user --trust hadrius-codebase https://mcp.hadriusapi.com/codebase
fi
if command -v claude >/dev/null && ! claude mcp list 2>/dev/null | grep -q '^hadrius-codebase:'; then
  claude mcp add --transport http hadrius-codebase https://mcp.hadriusapi.com/codebase --scope user
fi
python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt
npm install

# Re-point and restart the background bridge daemon.
if [[ "$(uname -s)" == "Darwin" ]]; then
  PLIST="$HOME/Library/LaunchAgents/com.kbstudio.aibridge.plist"

  launchctl unload "$PLIST" 2>/dev/null || true

  if lsof -ti :8787 >/dev/null 2>&1; then
    kill -9 $(lsof -ti :8787) 2>/dev/null || true
  fi

  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.kbstudio.aibridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$REPO_DIR/tools/ai-bridge.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$HOME/.npm-global/bin</string>
    <key>KBS_BRIDGE_PORT</key><string>8787</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/kbstudio-ai-bridge.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/kbstudio-ai-bridge.log</string>
</dict>
</plist>
EOF

  launchctl load "$PLIST"
  echo "✓ Switched background bridge to beta (launchd: com.kbstudio.aibridge)"

elif [[ "$(uname -s)" == "Linux" ]]; then
  UNIT_DIR="$HOME/.config/systemd/user"
  UNIT="$UNIT_DIR/kbstudio-ai-bridge.service"
  mkdir -p "$UNIT_DIR"

  systemctl --user stop kbstudio-ai-bridge 2>/dev/null || true

  cat > "$UNIT" <<EOF
[Unit]
Description=KB Studio AI narration bridge (Beta)

[Service]
ExecStart=$NODE_BIN $REPO_DIR/tools/ai-bridge.mjs
Environment=KBS_BRIDGE_PORT=8787
Environment=PATH=$NODE_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Restart=always

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable --now kbstudio-ai-bridge
  echo "✓ Switched background bridge to beta (systemd user service)"
fi

printf '\nSetup complete. Gemini CLI is the temporary primary AI provider with the Hadrius MCP. The beta bridge is running in the background.\n'

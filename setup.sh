#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
REPO_DIR="$(pwd)"

echo "=== Setting up Hadrius Studio Beta ==="

OS="$(uname -s)"
ARCH="$(uname -m)"

# Helper: Persist a directory to PATH in the current session and in shell profiles
persist_path() {
  local dir="$1"
  case ":$PATH:" in
    *":$dir:"*) ;;
    *) export PATH="$dir:$PATH" ;;
  esac

  if [[ "$OS" == "Darwin" ]]; then
    for profile in "$HOME/.zprofile" "$HOME/.zshrc"; do
      if [[ ! -f "$profile" ]] || ! grep -qs "$dir" "$profile" 2>/dev/null; then
        echo "export PATH=\"$dir:\$PATH\"" >> "$profile"
      fi
    done
  elif [[ "$OS" == "Linux" ]]; then
    for profile in "$HOME/.bashrc" "$HOME/.profile"; do
      if [[ ! -f "$profile" ]] || ! grep -qs "$dir" "$profile" 2>/dev/null; then
        echo "export PATH=\"$dir:\$PATH\"" >> "$profile"
      fi
    done
  fi
}

# Helper: Persist Homebrew environment to shell profiles
persist_brew() {
  local brew_bin="$1"
  eval "$("$brew_bin" shellenv)"
  if [[ "$OS" == "Darwin" ]]; then
    for profile in "$HOME/.zprofile" "$HOME/.zshrc"; do
      if [[ ! -f "$profile" ]] || ! grep -qs 'brew shellenv' "$profile" 2>/dev/null; then
        echo "eval \"\$($brew_bin shellenv)\"" >> "$profile"
      fi
    done
  fi
}

# 0. Homebrew check (macOS) - offer to install if missing and interactive
if [[ "$OS" == "Darwin" ]]; then
  # Detect existing brew if present on disk but not yet in subshell PATH
  if ! command -v brew >/dev/null; then
    if [[ -x "/opt/homebrew/bin/brew" ]]; then
      persist_brew "/opt/homebrew/bin/brew"
    elif [[ -x "/usr/local/bin/brew" ]]; then
      persist_brew "/usr/local/bin/brew"
    fi
  fi

  if ! command -v brew >/dev/null; then
    if [[ -t 0 ]]; then
      echo "Homebrew is recommended on macOS for managing developer tools and runtimes."
      read -r -p "Install Homebrew automatically now? [Y/n] " INSTALL_BREW || true
      if [[ "${INSTALL_BREW:-y}" =~ ^[Yy] ]]; then
        echo "Installing Homebrew (macOS admin password may be required)..."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || true
        if [[ -x "/opt/homebrew/bin/brew" ]]; then
          persist_brew "/opt/homebrew/bin/brew"
        elif [[ -x "/usr/local/bin/brew" ]]; then
          persist_brew "/usr/local/bin/brew"
        fi
      fi
    else
      echo "Non-interactive shell — skipping Homebrew prompt, proceeding with standalone fallbacks."
    fi
  else
    if [[ -x "/opt/homebrew/bin/brew" ]]; then
      persist_brew "/opt/homebrew/bin/brew"
    elif [[ -x "/usr/local/bin/brew" ]]; then
      persist_brew "/usr/local/bin/brew"
    fi
  fi

  if command -v brew >/dev/null; then
    echo "✓ Homebrew is ready."
  fi
fi

# 1. Ensure Node.js 20+ is installed (auto-install standalone or via brew if missing)
if ! command -v node >/dev/null; then
  echo "Node.js not found. Installing Node.js LTS automatically..."

  if [[ "$OS" == "Darwin" ]] && command -v brew >/dev/null; then
    echo "Installing Node via Homebrew..."
    brew install node
  elif [[ "$OS" == "Darwin" ]]; then
    echo "Installing standalone Node.js LTS into $HOME/.local/node..."
    NODE_ARCH="arm64"
    if [[ "$ARCH" == "x86_64" ]]; then NODE_ARCH="x64"; fi
    NODE_VER="v22.14.0"
    TARBALL="node-${NODE_VER}-darwin-${NODE_ARCH}.tar.gz"
    mkdir -p "$HOME/.local/node"
    curl -fsSL "https://nodejs.org/dist/${NODE_VER}/${TARBALL}" | tar -xz -C "$HOME/.local/node" --strip-components=1
    persist_path "$HOME/.local/node/bin"
  elif [[ "$OS" == "Linux" ]]; then
    echo "Installing standalone Node.js LTS into $HOME/.local/node..."
    NODE_ARCH="x64"
    if [[ "$ARCH" == "aarch64" || "$ARCH" == "arm64" ]]; then NODE_ARCH="arm64"; fi
    NODE_VER="v22.14.0"
    TARBALL="node-${NODE_VER}-linux-${NODE_ARCH}.tar.xz"
    mkdir -p "$HOME/.local/node"
    curl -fsSL "https://nodejs.org/dist/${NODE_VER}/${TARBALL}" | tar -xJ -C "$HOME/.local/node" --strip-components=1
    persist_path "$HOME/.local/node/bin"
  fi
fi

command -v node >/dev/null || { echo 'Error: Could not install Node.js automatically. Please install Node 20+ from https://nodejs.org' >&2; exit 1; }
echo "✓ Node.js $(node -v) is ready."

# Configure user-level npm prefix if default global directory is not writable (prevents EACCES sudo errors)
if command -v npm >/dev/null; then
  NPM_PREFIX="$(npm config get prefix 2>/dev/null || echo '/usr/local')"
  if [[ ! -w "$NPM_PREFIX" || ( -d "$NPM_PREFIX/lib" && ! -w "$NPM_PREFIX/lib" ) ]]; then
    mkdir -p "$HOME/.npm-global/bin" "$HOME/.npm-global/lib"
    npm config set prefix "$HOME/.npm-global" 2>/dev/null || true
    persist_path "$HOME/.npm-global/bin"
  fi
fi

# 2. Python 3 & Developer Tools check (detect Apple CLT shims)
if ! python3 -c "import sys" >/dev/null 2>&1; then
  echo "Python 3 runtime not ready."
  if [[ "$(uname -s)" == "Darwin" ]]; then
    echo "Xcode Command Line Tools are required on macOS. Requesting install..."
    xcode-select --install 2>/dev/null || true
    echo "Please complete the Xcode Command Line Tools dialog on your screen."
    echo "Waiting for installation to finish..."
    until xcode-select -p >/dev/null 2>&1 && python3 -c "import sys" >/dev/null 2>&1; do
      sleep 5
    done
    echo "✓ Xcode Command Line Tools and Python 3 are installed."
  else
    echo "Python 3 is required. Please install python3." >&2
    exit 1
  fi
fi
echo "✓ Python 3 ($(python3 --version 2>&1)) is ready."

# 3. Google Chrome check (required for running the unpacked extension)
if [[ "$(uname -s)" == "Darwin" ]]; then
  if [[ ! -d "/Applications/Google Chrome.app" && ! -d "$HOME/Applications/Google Chrome.app" ]]; then
    echo "Google Chrome not found in /Applications. Google Chrome is required to run the extension."
    if command -v brew >/dev/null; then
      echo "Installing Google Chrome via Homebrew..."
      brew install --cask google-chrome 2>/dev/null || true
    fi

    if [[ ! -d "/Applications/Google Chrome.app" && ! -d "$HOME/Applications/Google Chrome.app" ]]; then
      echo "Downloading official Google Chrome DMG..."
      TMP_CHROME_DMG="/tmp/googlechrome.dmg"
      if curl -fsSL "https://dl.google.com/chrome/mac/universal/stable/GGRO/googlechrome.dmg" -o "$TMP_CHROME_DMG" 2>/dev/null; then
        echo "Mounting and installing Google Chrome..."
        MOUNT_DIR=$(mktemp -d /tmp/chrome-mount.XXXXXX)
        hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT_DIR" "$TMP_CHROME_DMG" >/dev/null 2>&1 || true
        if [[ -d "$MOUNT_DIR/Google Chrome.app" ]]; then
          cp -R "$MOUNT_DIR/Google Chrome.app" /Applications/ 2>/dev/null || cp -R "$MOUNT_DIR/Google Chrome.app" "$HOME/Applications/" 2>/dev/null || true
        fi
        hdiutil detach "$MOUNT_DIR" -force >/dev/null 2>&1 || true
        rm -rf "$MOUNT_DIR" "$TMP_CHROME_DMG"
      fi
    fi

    if [[ -d "/Applications/Google Chrome.app" || -d "$HOME/Applications/Google Chrome.app" ]]; then
      echo "✓ Google Chrome is ready."
    else
      echo "⚠ Warning: Could not auto-install Google Chrome. Please install Chrome from https://google.com/chrome"
    fi
  else
    echo "✓ Google Chrome is ready."
  fi
fi

# 4. FFmpeg & FFprobe check (auto-install standalone if missing)
if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null || ! ffmpeg -version >/dev/null 2>&1 || ! ffprobe -version >/dev/null 2>&1; then
  echo "FFmpeg/FFprobe not found or cannot execute. Installing automatically..."
  OS="$(uname -s)"
  ARCH="$(uname -m)"
  mkdir -p "$HOME/.local/bin"
  export PATH="$HOME/.local/bin:$PATH"

  if [[ "$OS" == "Darwin" ]] && command -v brew >/dev/null; then
    echo "Installing FFmpeg via Homebrew..."
    brew install ffmpeg 2>/dev/null || true
  fi

  if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null || ! ffmpeg -version >/dev/null 2>&1 || ! ffprobe -version >/dev/null 2>&1; then
    if [[ "$OS" == "Darwin" ]]; then
      # On Apple Silicon, ensure Rosetta 2 is available if running prebuilt x86_64 binaries
      if [[ "$ARCH" == "arm64" ]]; then
        if ! /usr/bin/arch -x86_64 /usr/bin/true >/dev/null 2>&1; then
          echo "Installing Rosetta 2 for prebuilt binary compatibility..."
          softwareupdate --install-rosetta --agree-to-license 2>/dev/null || true
        fi
      fi

      echo "Downloading prebuilt FFmpeg & FFprobe for macOS into $HOME/.local/bin..."
      TMP_FFMPEG="/tmp/ffmpeg-dl.zip"
      TMP_FFPROBE="/tmp/ffprobe-dl.zip"
      curl -fsSL "https://evermeet.cx/ffmpeg/getrelease/zip" -o "$TMP_FFMPEG" 2>/dev/null || true
      if [[ -f "$TMP_FFMPEG" ]]; then
        unzip -q -o "$TMP_FFMPEG" -d "$HOME/.local/bin" 2>/dev/null || true
        rm -f "$TMP_FFMPEG"
      fi
      curl -fsSL "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip" -o "$TMP_FFPROBE" 2>/dev/null || true
      if [[ -f "$TMP_FFPROBE" ]]; then
        unzip -q -o "$TMP_FFPROBE" -d "$HOME/.local/bin" 2>/dev/null || true
        rm -f "$TMP_FFPROBE"
      fi
      chmod +x "$HOME/.local/bin/ffmpeg" "$HOME/.local/bin/ffprobe" 2>/dev/null || true
      xattr -dr com.apple.quarantine "$HOME/.local/bin/ffmpeg" "$HOME/.local/bin/ffprobe" 2>/dev/null || true
    elif [[ "$OS" == "Linux" ]]; then
      sudo apt-get update && sudo apt-get install -y ffmpeg 2>/dev/null || true
    fi
  fi

  persist_path "$HOME/.local/bin"
fi

if ffmpeg -version >/dev/null 2>&1 && ffprobe -version >/dev/null 2>&1; then
  echo "✓ FFmpeg & FFprobe are ready."
else
  echo '⚠ Warning: FFmpeg/FFprobe could not be verified. Videos may fail to assemble.'
fi

# 5. Claude CLI check (auto-install if missing)
if ! command -v claude >/dev/null; then
  echo "Claude CLI not found. Installing @anthropic-ai/claude-code..."
  npm install -g @anthropic-ai/claude-code || {
    echo "⚠ Could not auto-install Claude CLI globally. Please run:"
    echo "  npm install -g @anthropic-ai/claude-code"
  }
fi
if command -v claude >/dev/null; then
  echo "✓ Claude CLI is ready."
fi

# Migrate .env if needed from prior Hadrius Studio installs
if [[ ! -f .env ]]; then
  for candidate in "$HOME/kb-studio/.env" "$HOME/hadrius-studio/.env" "../hadrius-studio/.env" "../kb-studio/.env"; do
    if [[ -f "$candidate" ]]; then
      echo "Migrating existing credentials from $candidate..."
      cp "$candidate" .env
      break
    fi
  done
  if [[ ! -f .env && -f .env.example ]]; then
    cp .env.example .env
  fi
fi

touch .env
chmod 600 .env

# Shared team repository configuration (Neon database via pylon-webhook-service)
if grep -qs '^STUDIO_SHARED_SECRET=.\+' .env 2>/dev/null; then
  echo "✓ Shared team repository: configured (.env)."
else
  # Try importing from candidate locations
  IMPORTED_SECRET=""
  for cand in "$HOME/kb-studio/.env" "$HOME/hadrius-studio/.env" "../kb-studio/.env" "$HOME/.hermes/.env"; do
    if [[ -f "$cand" ]] && grep -qs '^STUDIO_SHARED_SECRET=.\+' "$cand" 2>/dev/null; then
      IMPORTED_SECRET="$(grep '^STUDIO_SHARED_SECRET=' "$cand" | head -n1 | cut -d'=' -f2- | tr -d '\"'\')"
      break
    fi
  done

  if [[ -n "$IMPORTED_SECRET" ]]; then
    { grep -v '^STUDIO_SHARED_SECRET=' .env 2>/dev/null || true; echo "STUDIO_SHARED_SECRET=$IMPORTED_SECRET"; } > .env.tmp && mv .env.tmp .env
    chmod 600 .env
    echo "✓ Shared team repository: imported STUDIO_SHARED_SECRET."
  else
    echo "Hadrius Studio connects to a shared team repository (Neon) so everyone shares"
    echo "the same workflows, walkthrough scripts, and live article coverage."
    echo "Ask Stephen for the STUDIO_SHARED_SECRET."
    STUDIO_SECRET=""
    if [[ -t 0 ]]; then
      read -r -p "Paste STUDIO_SHARED_SECRET (or press Enter to skip for now): " STUDIO_SECRET || true
    fi
    if [[ -n "${STUDIO_SECRET:-}" ]]; then
      { grep -v '^STUDIO_SHARED_SECRET=' .env 2>/dev/null || true; echo "STUDIO_SHARED_SECRET=$STUDIO_SECRET"; } > .env.tmp && mv .env.tmp .env
      chmod 600 .env
      echo "✓ Saved STUDIO_SHARED_SECRET to .env."
    else
      echo "⚠ Skipped. Add STUDIO_SHARED_SECRET=... to .env later to connect to the shared repository."
    fi
  fi
  unset IMPORTED_SECRET
fi

# Ensure beta URLs are used even if credentials were migrated from legacy installs
if grep -qs 'studio-scripts' .env 2>/dev/null && ! grep -qs 'studio-beta-scripts' .env 2>/dev/null; then
  sed -i '' 's/studio-scripts/studio-beta-scripts/g' .env 2>/dev/null || sed -i 's/studio-scripts/studio-beta-scripts/g' .env 2>/dev/null || true
fi
if grep -qs 'studio-coverage' .env 2>/dev/null && ! grep -qs 'studio-beta-coverage' .env 2>/dev/null; then
  sed -i '' 's/studio-coverage/studio-beta-coverage/g' .env 2>/dev/null || sed -i 's/studio-coverage/studio-beta-coverage/g' .env 2>/dev/null || true
fi

if ! grep -qs '^STUDIO_LIBRARY_URL=.\+' .env 2>/dev/null; then
  echo "STUDIO_LIBRARY_URL=https://pylon-webhook-service.vercel.app/api/studio-beta-scripts" >> .env
fi

# The bridge degrades quietly without these — publishing just fails at render time, and the AI
# fallback never kicks in — so say up front which optional keys this machine is missing.
if ! grep -qs '^PYLON_API_TOKEN=.\+' .env 2>/dev/null; then
  echo "⚠ PYLON_API_TOKEN is not set in .env — 'Render + Article' and the Recorded tab's Pylon sync won't work until it is."
fi
if ! grep -qs '^GEMINI_API_KEY=.\+' .env 2>/dev/null; then
  echo "ℹ GEMINI_API_KEY is not set in .env — optional; it's only the fallback when the Claude CLI is unavailable."
fi
if ! grep -qs '^ELEVENLABS_API_KEY=.\+' .env 2>/dev/null; then
  echo "ℹ ELEVENLABS_API_KEY is not set in .env — videos will use the free edge-tts voice instead of ElevenLabs (Matilda)."
fi

# Configure Hadrius Codebase MCP for Claude Code if installed
if command -v claude >/dev/null; then
  if ! claude mcp list 2>/dev/null | grep -q '^hadrius-codebase:'; then
    echo "Registering hadrius-codebase MCP server with Claude CLI..."
    claude mcp add --transport http hadrius-codebase https://mcp.hadriusapi.com/codebase --scope user 2>/dev/null || true
  fi
fi

# Ensure local workspace directories exist
mkdir -p scripts out out/_recordings audio data assets .browser-profile .test-browser-profile

# 6. Python virtual environment & dependencies
if [[ -d .venv ]] && ! .venv/bin/python -c "import sys" >/dev/null 2>&1; then
  echo "Detected moved or invalid .venv from another machine/path. Recreating .venv..."
  rm -rf .venv
fi
if [[ ! -d .venv ]]; then
  echo "Creating Python virtual environment (.venv)..."
  python3 -m venv .venv
fi
echo "Installing Python dependencies (edge-tts, Pillow)..."
.venv/bin/pip install -q --upgrade pip 2>/dev/null || true
.venv/bin/pip install -q -r requirements.txt

# 7. Node dependencies
echo "Installing Node dependencies..."
npm install

# 8. Playwright Chromium browser for automated playback & recording
echo "Installing Playwright Chromium browser..."
npx playwright install chromium
if [[ "$(uname -s)" == "Linux" ]]; then
  echo "Installing Linux browser system dependencies..."
  npx playwright install-deps chromium 2>/dev/null || true
fi

echo "Verifying Playwright Chromium executable..."
node -e "
import('playwright').then(async ({ chromium }) => {
  const p = chromium.executablePath();
  const fs = await import('node:fs');
  if (fs.existsSync(p)) {
    console.log('✓ Playwright Chromium verified at:', p);
  } else {
    console.warn('⚠ Playwright Chromium not found at:', p);
  }
}).catch(e => console.warn('⚠ Playwright check warning:', e.message));
"

NODE_PATH_BIN="$(command -v node)"
NODE_BIN_DIR="$(dirname "$NODE_PATH_BIN")"

# 9. Background daemon setup (launchd on macOS / systemd on Linux)
if [[ "$(uname -s)" == "Darwin" ]]; then
  PLIST_DIR="$HOME/Library/LaunchAgents"
  PLIST="$PLIST_DIR/com.kbstudio.aibridge.plist"
  mkdir -p "$PLIST_DIR" "$HOME/Library/Logs"

  # 1. Unload any existing launchd services that reference ai-bridge or hadrius-studio
  for old_plist in "$PLIST_DIR"/com.kbstudio.* "$PLIST_DIR"/com.hadrius*studio* "$PLIST_DIR"/com.hadrius*bridge*; do
    if [[ -f "$old_plist" ]]; then
      if grep -qs 'ai-bridge' "$old_plist" 2>/dev/null; then
        echo "Unloading previous background service: $(basename "$old_plist")..."
        launchctl unload "$old_plist" 2>/dev/null || true
      fi
    fi
  done
  launchctl unload "$PLIST" 2>/dev/null || true

  # 2. Terminate any process currently bound to port 8787
  if lsof -ti :8787 >/dev/null 2>&1; then
    echo "Stopping existing process on port 8787..."
    kill -9 $(lsof -ti :8787) 2>/dev/null || true
  fi

  # Wait for port 8787 to be fully released
  for i in {1..5}; do
    if ! lsof -ti :8787 >/dev/null 2>&1; then break; fi
    sleep 0.3
  done

  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.kbstudio.aibridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_PATH_BIN</string>
    <string>$REPO_DIR/tools/ai-bridge.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$REPO_DIR/.venv/bin:$NODE_BIN_DIR:$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$HOME/.npm-global/bin</string>
    <key>KBS_BRIDGE_PORT</key><string>8787</string>
  </dict>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/kbstudio-ai-bridge.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/kbstudio-ai-bridge.log</string>
</dict>
</plist>
EOF

  launchctl load "$PLIST"
  echo "✓ Installed background bridge service (launchd: com.kbstudio.aibridge)."

  # Health check the bridge service
  echo "Verifying bridge service health on port 8787..."
  HEALTH_OK=false
  for i in {1..10}; do
    if curl -s "http://127.0.0.1:8787/health" | grep -q '"ok":true' 2>/dev/null; then
      HEALTH_OK=true
      break
    fi
    sleep 0.5
  done
  if [[ "$HEALTH_OK" == "true" ]]; then
    echo "✓ Bridge is running and healthy at http://127.0.0.1:8787"
  else
    echo "⚠ Bridge started but not responding yet. Check logs at: ~/Library/Logs/kbstudio-ai-bridge.log"
  fi
elif [[ "$(uname -s)" == "Linux" ]]; then
  UNIT_DIR="$HOME/.config/systemd/user"
  UNIT="$UNIT_DIR/kbstudio-ai-bridge.service"
  mkdir -p "$UNIT_DIR"

  for old_svc in kbstudio-ai-bridge hadrius-studio hadrius-studio-aibridge; do
    systemctl --user stop "$old_svc" 2>/dev/null || true
    systemctl --user disable "$old_svc" 2>/dev/null || true
  done

  cat > "$UNIT" <<EOF
[Unit]
Description=KB Studio AI narration bridge (Beta)

[Service]
ExecStart=$NODE_PATH_BIN $REPO_DIR/tools/ai-bridge.mjs
Environment=KBS_BRIDGE_PORT=8787
Environment=PATH=$NODE_BIN_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.local/bin
Restart=always

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable --now kbstudio-ai-bridge
  echo "✓ Installed background bridge service (systemd: kbstudio-ai-bridge)."
fi

cat <<EOF

===================================================================
🎉 Setup Complete! How to load the extension in Google Chrome:
===================================================================

1. Open Google Chrome.
2. Go to:  chrome://extensions
3. Turn ON "Developer mode" in the top-right corner.
4. Click "Load unpacked" (top-left).
5. Select this folder:
   $REPO_DIR/extension

6. Click the Extensions (puzzle piece) icon in Chrome and pin "Hadrius Studio".
7. Navigate to https://app.hadrius.com to start recording!

Optional Next Steps:
- Sign into Claude CLI:     claude login
- Sign into Hadrius MCP:    claude mcp login hadrius-codebase
===================================================================
EOF

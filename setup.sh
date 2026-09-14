#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
REPO_DIR="$(pwd)"

# 1. Ensure Node.js 20+ is installed (auto-install standalone or via brew if missing)
if ! command -v node >/dev/null; then
  echo "Node.js not found. Installing Node.js LTS automatically..."
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  if [[ "$OS" == "Darwin" && $(command -v brew) ]]; then
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
    export PATH="$HOME/.local/node/bin:$PATH"

    SHELL_PROFILE="$HOME/.zshrc"
    if [[ ! -f "$SHELL_PROFILE" && -f "$HOME/.bash_profile" ]]; then SHELL_PROFILE="$HOME/.bash_profile"; fi
    if ! grep -qs '/.local/node/bin' "$SHELL_PROFILE" 2>/dev/null; then
      echo 'export PATH="$HOME/.local/node/bin:$PATH"' >> "$SHELL_PROFILE"
    fi
  elif [[ "$OS" == "Linux" ]]; then
    echo "Installing standalone Node.js LTS into $HOME/.local/node..."
    NODE_ARCH="x64"
    if [[ "$ARCH" == "aarch64" || "$ARCH" == "arm64" ]]; then NODE_ARCH="arm64"; fi
    NODE_VER="v22.14.0"
    TARBALL="node-${NODE_VER}-linux-${NODE_ARCH}.tar.xz"
    mkdir -p "$HOME/.local/node"
    curl -fsSL "https://nodejs.org/dist/${NODE_VER}/${TARBALL}" | tar -xJ -C "$HOME/.local/node" --strip-components=1
    export PATH="$HOME/.local/node/bin:$PATH"
    if ! grep -qs '/.local/node/bin' "$HOME/.bashrc" 2>/dev/null; then
      echo 'export PATH="$HOME/.local/node/bin:$PATH"' >> "$HOME/.bashrc"
    fi
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
    export PATH="$HOME/.npm-global/bin:$PATH"

    SHELL_PROFILE="$HOME/.zshrc"
    if [[ ! -f "$SHELL_PROFILE" && -f "$HOME/.bash_profile" ]]; then SHELL_PROFILE="$HOME/.bash_profile"; fi
    if ! grep -qs '/.npm-global/bin' "$SHELL_PROFILE" 2>/dev/null; then
      echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> "$SHELL_PROFILE"
    fi
  fi
fi

# 2. Python 3 check
command -v python3 >/dev/null || {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    echo "Python 3 not found. Installing Xcode Command Line Tools..."
    xcode-select --install || true
  else
    echo "Python 3 is required. Please install python3." >&2
    exit 1
  fi
}

# 3. FFmpeg & FFprobe check (auto-install if missing)
if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
  echo "FFmpeg/FFprobe not found. Installing automatically..."
  OS="$(uname -s)"
  mkdir -p "$HOME/.local/bin"
  export PATH="$HOME/.local/bin:$PATH"

  if [[ "$OS" == "Darwin" && $(command -v brew) ]]; then
    echo "Installing FFmpeg via Homebrew..."
    brew install ffmpeg 2>/dev/null || true
  fi

  if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
    if [[ "$OS" == "Darwin" ]]; then
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
    elif [[ "$OS" == "Linux" ]]; then
      sudo apt-get update && sudo apt-get install -y ffmpeg 2>/dev/null || true
    fi
  fi

  SHELL_PROFILE="$HOME/.zshrc"
  if [[ ! -f "$SHELL_PROFILE" && -f "$HOME/.bash_profile" ]]; then SHELL_PROFILE="$HOME/.bash_profile"; fi
  if ! grep -qs '/.local/bin' "$SHELL_PROFILE" 2>/dev/null; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$SHELL_PROFILE"
  fi
fi

if command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null; then
  echo "✓ FFmpeg & FFprobe are ready."
else
  echo '⚠ Warning: FFmpeg/FFprobe could not be installed automatically.'
fi

# 4. Claude CLI check (auto-install if missing)
if ! command -v claude >/dev/null; then
  echo "Claude CLI not found. Installing @anthropic-ai/claude-code..."
  npm install -g @anthropic-ai/claude-code || {
    echo "⚠ Could not auto-install Claude CLI globally. Please run:"
    echo "  npm install -g @anthropic-ai/claude-code"
  }
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
    read -r -p "Paste STUDIO_SHARED_SECRET (or press Enter to skip for now): " STUDIO_SECRET || true
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

if ! claude mcp list 2>/dev/null | grep -q '^hadrius-codebase:'; then
  claude mcp add --transport http hadrius-codebase https://mcp.hadriusapi.com/codebase --scope user
fi

# Ensure local workspace directories exist
mkdir -p scripts out audio data .browser-profile .test-browser-profile

if [[ ! -d .venv ]]; then
  echo "Creating Python virtual environment (.venv)..."
  python3 -m venv .venv
fi
echo "Installing Python dependencies (edge-tts, Pillow)..."
.venv/bin/pip install -q -r requirements.txt

echo "Installing Node dependencies..."
npm install

echo "Installing Playwright Chromium browser for AI recording..."
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

# Update background daemon to run this beta bridge automatically
if [[ "$(uname -s)" == "Darwin" ]]; then
  PLIST_DIR="$HOME/Library/LaunchAgents"
  PLIST="$PLIST_DIR/com.kbstudio.aibridge.plist"
  mkdir -p "$PLIST_DIR" "$HOME/Library/Logs"

  launchctl unload "$PLIST" 2>/dev/null || true

  # Terminate any process currently bound to port 8787
  if lsof -ti :8787 >/dev/null 2>&1; then
    kill -9 $(lsof -ti :8787) 2>/dev/null || true
  fi

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
    <key>PATH</key><string>$REPO_DIR/.venv/bin:$NODE_BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$HOME/.npm-global/bin</string>
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
  echo "Switched background bridge to beta (launchd: com.kbstudio.aibridge)."
elif [[ "$(uname -s)" == "Linux" ]]; then
  UNIT_DIR="$HOME/.config/systemd/user"
  UNIT="$UNIT_DIR/kbstudio-ai-bridge.service"
  mkdir -p "$UNIT_DIR"

  systemctl --user stop kbstudio-ai-bridge 2>/dev/null || true

  cat > "$UNIT" <<EOF
[Unit]
Description=KB Studio AI narration bridge (Beta)

[Service]
ExecStart=$NODE_PATH_BIN $REPO_DIR/tools/ai-bridge.mjs
Environment=KBS_BRIDGE_PORT=8787
Environment=PATH=$NODE_BIN_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Restart=always

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable --now kbstudio-ai-bridge
  echo "Switched background bridge to beta (systemd: kbstudio-ai-bridge)."
fi

printf '\nSetup complete. Run "claude login" and "claude mcp login hadrius-codebase" if needed.\n'

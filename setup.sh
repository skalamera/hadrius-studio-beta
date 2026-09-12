#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null || { echo 'Node 20+ is required.' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'Python 3 is required.' >&2; exit 1; }
command -v ffmpeg >/dev/null || echo 'Warning: FFmpeg is required to render MP4 files.'
command -v claude >/dev/null || { echo 'Install Claude CLI: npm install -g @anthropic-ai/claude-code' >&2; exit 1; }
if ! claude mcp list 2>/dev/null | grep -q '^hadrius-codebase:'; then
  claude mcp add --transport http hadrius-codebase https://mcp.hadriusapi.com/codebase --scope user
fi
python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt
npm install
printf '\nSetup complete. Run "claude login" and "claude mcp login hadrius-codebase" if needed, then "npm start".\n'

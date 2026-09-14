#!/bin/bash
# Render only from slides captured during the live recording. No browser replay.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
S="${1:?usage: ./render.sh path/to/walkthrough.script.json}"
N=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['name'])" "$S")
RID=$(python3 -c "import json,sys; print((json.load(open(sys.argv[1])).get('recording') or {}).get('id',''))" "$S")
[ -n "$RID" ] || { echo "script has no live recording id" >&2; exit 2; }
[ -d "out/_recordings/$RID" ] || { echo "captured slides not found for recording $RID" >&2; exit 2; }
rm -rf "out/$N"
node renderer/from-recording.mjs "$S" "out/$N"
PYTHON=.venv/bin/python
[ -x "$PYTHON" ] || PYTHON=python3
"$PYTHON" renderer/assemble.py "out/$N"
echo "done: out/$N/$N.mp4"

# Hadrius Studio Lite

A Chrome side-panel extension for producing short Hadrius knowledge-base walkthroughs from live user recordings.

## What it does

- Temporarily scans `hadrius_frontend` through the Hadrius MCP using Gemini CLI, with Claude fallback. Every saved plan step requires source evidence.
- Groups workflow opportunities into Testing Program, People Oversight, Branches, Communications, Marketing, and Account Surveillance.
- Shows the current articles in each module's Pylon knowledge-base collection. The panel refreshes every minute and on launch, so additions and deletions are reflected without an extension release.
- Opens every article directly in Pylon and automatically matches same-title articles to workflow opportunities.
- Gives the recorder a source-grounded step-by-step plan.
- Records clicks, typing, key presses, navigation, and a screenshot for every live step in PROD or Staging.
- Automatically drafts narration as soon as recording stops.
- Keeps every action and narration line editable, exports the script as JSON, and renders an MP4 directly from the captured slides.
- Never replays a workflow.

## Install

Requirements: macOS (or Linux), Google Chrome, and a Claude subscription for the Claude CLI. `setup.sh` installs everything else it can't find — Node, Python tooling, FFmpeg, the Claude CLI, the Hadrius codebase MCP, Playwright's Chromium — and registers the bridge as a background service, so there is nothing to keep running by hand.

```bash
bash setup.sh
```

Setup asks for the team's `STUDIO_SHARED_SECRET` (ask Stephen) so you share the same workflows and script library as everyone else. It then tells you which optional keys are missing from `.env`:

- `PYLON_API_TOKEN` — needed for **Render + Article** and the Recorded tab's Pylon sync.
- `ELEVENLABS_API_KEY` — narration voice for rendered videos (ElevenLabs "Matilda" by default; set `ELEVENLABS_VOICE_ID` to change). Without it, renders fall back to the free edge-tts voice.
- `GEMINI_API_KEY` — optional; only used as a fallback when the Claude CLI is unavailable.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` — optional; when set, every rendered video (both **Render MP4** and **Render + Article**) is also mirrored into that Google account's Drive as an "Anyone with the link" viewer copy, linked from the Recorded tab next to the Pylon article. One-time setup for stephen@hadrius.com's account:
  1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create an OAuth client of type **Desktop app** (any project with the Drive API enabled) — this gives you a client ID and secret.
  2. Open the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground), click the gear icon, check "Use your own OAuth credentials", and paste in that client ID/secret.
  3. In Step 1, authorize scope `https://www.googleapis.com/auth/drive.file`, sign in as stephen@hadrius.com, then in Step 2 click "Exchange authorization code for tokens" and copy the **refresh token**.
  4. Put all three values in `.env` as `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, then restart the bridge.
  Optionally set `GOOGLE_DRIVE_FOLDER_ID` to upload into a specific Drive folder instead of "My Drive"'s root.

Afterwards, sign in once: `claude login`, then `claude mcp login hadrius-codebase` (the Hadrius codebase MCP is what grounds plans and narration in the real source).

In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the `extension/` folder. Pin **Hadrius Studio** from the extensions menu.

## Use

1. Open the Studio side panel while on any Hadrius PROD or Staging company (the bridge runs in the background; the dot in the header is green when it's reachable).
2. Either click **Record now** for an ad hoc walkthrough, or **Record from a plan…** to pick an opportunity from the To Record list (or generate a plan with AI — beta).
3. Perform the workflow normally in the tab.
4. Click **Stop & draft narration**. Claude drafts narration grounded in the codebase; Gemini is used only if the Claude CLI is unavailable.
5. Edit any action, narration, or caption, then click **Render MP4** (or **Render + Article** to also publish a draft Pylon article).

Plans are shared live: every install reads and writes the step-by-step plans through the team library, so a plan someone edits, enhances, or generates shows up for everyone within about a minute (the View Plan dialog says who last changed it and when). `data/workflows.json` is just this machine's cache of that — no `git pull` is needed to stay in sync on plan content; `update.sh` is only for code changes.

Every plan-writing path (Scan codebase, Generate plan, Enhance plan) follows the same grounding contract: read the real components, one concrete control per step with its label quoted from the code, and a per-step verified/unverified record. **Auto-record is only offered when every step is verified** — an unverified step is exactly where the browser agent stalls — so an opportunity shows "Auto-record unavailable" (with the reason) until Enhance re-grounds it. Record manually in the meantime.

Anything marked **Beta** in amber — Auto-record, Enhance Plan, Generate plan, Scan codebase — is AI-driven and can be inconsistent. Review its output before recording or publishing, and be especially careful with Auto-record, which drives your browser on its own.

Outputs are written to `out/<walkthrough name>/`.

## Pylon collections

The six collection IDs live in `tools/pylon.mjs`. All article visibility states are shown, with Published/Draft badges. Article synchronization is read-only until a video is rendered and explicitly published through supported bridge behavior.

## Architecture

- `extension/content.js`: live semantic event capture.
- `extension/background.js`: recording state, screenshot capture, persistence, narration and render requests.
- `extension/sidepanel.*`: workflow catalog, Pylon articles, recording plan, and editable script.
- `tools/ai-bridge.mjs`: localhost bridge for Pylon, Claude/Gemini, capture storage, scan jobs, and rendering.
- `tools/coverage-scan.mjs`: MCP-grounded workflow discovery.
- `renderer/from-recording.mjs`: builds slides only from live captures.
- `renderer/assemble.py`: narration, captions, motion, audio, and MP4 output.

The localhost bridge keeps Pylon credentials and model access outside the Chrome extension.

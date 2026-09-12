# Hadrius Studio Lite

A Chrome side-panel extension for producing short Hadrius knowledge-base walkthroughs from live user recordings.

## What it does

- Scans `hadrius_frontend` through the Hadrius MCP using Claude CLI, with Gemini fallback.
- Groups workflow opportunities into Testing Program, People Oversight, Branches, Communications, Marketing, and Account Surveillance.
- Shows the current articles in each module's Pylon knowledge-base collection. The panel refreshes every minute and on launch, so additions and deletions are reflected without an extension release.
- Opens every article directly in Pylon and automatically matches same-title articles to workflow opportunities.
- Gives the recorder a source-grounded step-by-step plan.
- Records clicks, typing, key presses, navigation, and a screenshot for every live step in PROD or Staging.
- Automatically drafts narration as soon as recording stops.
- Keeps every action and narration line editable, exports the script as JSON, and renders an MP4 directly from the captured slides.
- Never replays a workflow.

## Install

Requirements: Node 20+, Python 3, FFmpeg, Claude CLI, and Chrome.

```bash
cp .env.example .env
./setup.sh
npm start
```

Set `PYLON_API_TOKEN` in `.env`. For fallback AI, set `GEMINI_API_KEY`. Authenticate Claude once with `claude login`. `setup.sh` configures the Hadrius codebase MCP for Claude when its URL is available.

In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `extension/`.

## Use

1. Keep `npm start` running.
2. Open the Studio side panel while on any Hadrius PROD or Staging company.
3. Choose a workflow and review its recording plan.
4. Click **Record** and perform the workflow normally.
5. Click **Stop & draft narration**. Claude immediately drafts narration; Gemini is used if Claude is unavailable.
6. Edit any action, narration, or caption, then click **Render MP4**.

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

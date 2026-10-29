# Hadrius Studio Lite

A Chrome side-panel extension for producing short Hadrius knowledge-base walkthroughs from live user recordings.

## What it does

- Scans `hadrius_frontend` through the Hadrius MCP using the Claude CLI. Every saved plan step requires source evidence.
- Groups workflow opportunities into Testing Program, People Oversight, Branches, Communications, Marketing, and Account Surveillance.
- Shows the current articles in each module's Pylon knowledge-base collection. The panel refreshes every minute and on launch, so additions and deletions are reflected without an extension release.
- Opens every article directly in Pylon and automatically matches same-title articles to workflow opportunities.
- Gives the recorder a source-grounded step-by-step plan.
- Records clicks, typing, key presses, navigation, and a screenshot for every live step in PROD or Staging.
- Automatically drafts narration as soon as recording stops.
- Keeps every action and narration line editable, exports the script as JSON, and renders an MP4 directly from the captured slides.
- Never replays a workflow.

## Install

### Teammates: the installer (no Terminal, nothing to type)

Ask Stephen for **Hadrius Studio Installer.zip**, unzip it, and double-click **Install Hadrius Studio**. It installs everything below, writes the team's credentials into `.env` for you, starts the background service, walks you through adding the extension to Chrome (checking each step off by itself), and offers a Claude sign-in at the end. The first time, macOS asks you to approve the app once (System Settings → Privacy & Security → **Open Anyway**); `READ ME FIRST.txt` in the zip has the exact clicks.

Run it again any time to update, repair, or sign in to Claude. It updates an existing install in place (wherever its background service points), and otherwise installs to `~/hadrius-studio-beta`. An install in `~/Downloads` is moved to `~/hadrius-studio-beta` first (or `-2`, … if that name is taken), keeping its `.env` and local renders; the Chrome step then has them remove the old card and add the new folder. Log: `~/Library/Logs/Hadrius Studio Installer/install.log`.

### Building the installer (Stephen)

```bash
bash installer/build.sh
```

This bakes this machine's `.env` into `dist/Hadrius Studio Installer.zip`, minus machine-only keys (`PR_WATCH_USER`, `STUDIO_USER`, `KBS_BRIDGE_PORT`, …), and prints which keys went in. Share that zip privately (Slack DM, Drive). **Never commit `dist/` or a team .env: this GitHub repo is public.** After changing any key, rebuild and re-share; running the new installer refreshes each person's `.env` (installer keys overwrite the same keys, other lines are kept). The app is ad hoc signed, not notarized, hence the one-time Open Anyway step.

### Manual install (developers)

Requirements: macOS (or Linux), Google Chrome, and a Claude subscription for the Claude CLI. `setup.sh` installs everything else it can't find — Node, Python tooling, FFmpeg, the Claude CLI, the Hadrius codebase MCP, Playwright's Chromium — and registers the bridge as a background service, so there is nothing to keep running by hand.

```bash
bash setup.sh
```

Setup asks for the team's `STUDIO_SHARED_SECRET` (ask Stephen) so you share the same workflows and script library as everyone else. It then tells you which optional keys are missing from `.env`:

- `PYLON_API_TOKEN` — needed for **Render + Article** and the Recorded tab's Pylon sync.
- `ELEVENLABS_API_KEY` — narration voice for rendered videos. Everyone defaults to ElevenLabs "Josh"; the render bar's Voice picker also offers Kristen, Jennifer, VoiceStudio's The Upbeat (if VoiceStudio is running) and the Mac's Samantha, each with a ▶ sample. Without the key, renders use VoiceStudio if it's running, else the free edge-tts voice.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` — optional; when set, every rendered video (both **Render MP4** and **Render + Article**) is also uploaded into the [Hadrius Academy folder](https://drive.google.com/drive/folders/1MlLinwFLBprG3Ybz8JAHhuL0V_VubTJr) in My Drive — the module subfolder matching the workflow's module (Testing Program, People Oversight, Branches, Communications, Marketing, Account Surveillance, or Other) — as an "Anyone with the link" viewer copy, linked from the Recorded tab next to the Pylon article. One-time setup for stephen@hadrius.com's account:
  1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create an OAuth client of type **Desktop app** (any project with the Drive API enabled) — this gives you a client ID and secret.
  2. Authorize scope `https://www.googleapis.com/auth/drive` (full Drive access is required to write into an existing folder by id — `drive.file` alone can't see folders it didn't create) as stephen@hadrius.com and get a refresh token — either via the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground) (gear icon → "Use your own OAuth credentials" → your client ID/secret → authorize that scope → "Exchange authorization code for tokens"), or by hitting the standard `https://accounts.google.com/o/oauth2/v2/auth` authorization endpoint yourself with `access_type=offline&prompt=consent` and exchanging the resulting code at `https://oauth2.googleapis.com/token`.
  3. Put all three values in `.env` as `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, then restart the bridge.
  The Hadrius Academy folder id and its module subfolder ids are hardcoded in `tools/gdrive.mjs` (`HADRIUS_ACADEMY_FOLDER_ID` / `MODULE_FOLDER_IDS`) — update them there if the folder is ever recreated or subfolders renamed. `GOOGLE_DRIVE_FOLDER_ID` overrides the per-module routing entirely and uploads everything into one specific folder instead, if that's ever wanted.

Afterwards, sign in once: run `claude` in Terminal and sign in (or `claude auth login`), then `claude mcp login hadrius-codebase` (the Hadrius codebase MCP is what grounds plans and narration in the real source). Every Studio AI feature (narration, plans, Pylon articles, scans, decks) runs on the Claude CLI only — there is no other AI provider or API key. If Claude isn't signed in, the panel header shows a red **Claude not connected** and AI actions fail with: "Claude isn't connected on this Mac. In Terminal run `claude` and sign in, then click Update in Studio (or restart the bridge)."

In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the `extension/` folder. Pin **Hadrius Studio** from the extensions menu.

## Use

1. Open the Studio side panel while on any Hadrius PROD or Staging company (the bridge runs in the background; the dot in the header is green when it's reachable).
2. Either click **Record now** for an ad hoc walkthrough, or **Record from a plan…** to pick an opportunity from the To Record list (or generate a plan with AI — beta).
3. Perform the workflow normally in the tab.
4. Click **Stop & draft narration**. Claude drafts narration grounded in the codebase (Claude must be signed in on this Mac; see Setup).
5. Edit any action, narration, or caption, then click **Render MP4** (or **Render + Article** to also publish a draft Pylon article).

Plans are shared live: every install reads and writes the step-by-step plans through the team library, so a plan someone edits, enhances, or generates shows up for everyone within about a minute (the View Plan dialog says who last changed it and when). `data/workflows.json` is just this machine's cache of that — no `git pull` is needed to stay in sync on plan content; `update.sh` is only for code changes.

Every plan-writing path (Scan codebase, Generate plan, Enhance plan) follows the same grounding contract: read the real components, one concrete control per step with its label quoted from the code, and a per-step verified/unverified record. **Auto-record is only offered when every step is verified** — an unverified step is exactly where the browser agent stalls — so an opportunity shows "Auto-record unavailable" (with the reason) until Enhance re-grounds it. Record manually in the meantime.

Anything marked **Beta** in amber — Auto-record, Enhance Plan, Generate plan, Scan codebase — is AI-driven and can be inconsistent. Review its output before recording or publishing, and be especially careful with Auto-record, which drives your browser on its own.

Outputs are written to `out/<walkthrough name>/`.

## Create ✨ (slide decks)

The **Create ✨** tab builds training slide decks from the screenshots every recorded walkthrough already has (the Drive `_recordings` folder plus the shared script library).

1. Check **📚 Library** first: every finished deck is saved to the shared [Slide Decks](https://drive.google.com/drive/folders/1aMR971LkbSTwMn5psY5wKqsCuvPaGjd5) Drive folder and is searchable and downloadable from there. While you type a request, matching decks also show up under **Already in the shared library**.
2. In **✨ New deck**, describe a workflow ("How to import employees") or a module ("Getting started with People Oversight"), or click an idea. Pick the audience (Admins, Employees, Both), a style (Standard, Detailed, Visual) and a length.
3. Claude picks the recordings that cover it and proposes an outline. Remove slides, ask for changes, or approve it.
4. On approval Claude writes each section after reading the real `hadrius_frontend` components through the hadrius-codebase MCP. Every bolded UI label is then checked: captured from the live product by the recorder, cited from a code file, or re-checked in a second pass that confirms, corrects, or un-bolds it.
5. `renderer/deck.py` marks up the screenshots (boxes come from the recorder's element positions, with OCR as a fallback; a step with no reliable position gets no box). Every box is checked against its screenshot first: a box over blank space, on other text while the label is elsewhere, or on a stale reused capture is dropped or moved, and a box only carries onto a later step's screenshot when the element's edges and text are unchanged there (`renderer/deck_boxes.py` draws contact sheets of every box for review). Then it builds the editable `.pptx`, exports a PDF (LibreOffice, else Keynote), and the bridge uploads both to the Slide Decks folder.

Local copies live in `out/_decks/<id>/`. Needs `python-pptx`, `pymupdf` and `ocrmac` (installed by `setup.sh` from `requirements.txt`) and LibreOffice or Keynote for the PDF.

## Pylon collections

The six collection IDs live in `tools/pylon.mjs`. All article visibility states are shown, with Published/Draft badges. Article synchronization is read-only until a video is rendered and explicitly published through supported bridge behavior.

## Architecture

- `extension/content.js`: live semantic event capture.
- `extension/background.js`: recording state, screenshot capture, persistence, narration and render requests.
- `extension/sidepanel.*`: workflow catalog, Pylon articles, recording plan, and editable script.
- `tools/ai-bridge.mjs`: localhost bridge for Pylon, Claude CLI, capture storage, scan jobs, and rendering.
- `tools/coverage-scan.mjs`: MCP-grounded workflow discovery.
- `renderer/from-recording.mjs`: builds slides only from live captures.
- `renderer/assemble.py`: narration, captions, motion, audio, and MP4 output.

The localhost bridge keeps Pylon credentials and model access outside the Chrome extension.

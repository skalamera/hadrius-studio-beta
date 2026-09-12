// Hadrius Studio renderer — from-recording: build report.json straight from the slides captured
// while the person clicked through the real app (extension/background.js captureStep), with no
// browser, no replay, no second visit to staging. This is the first render for every script that
// carries a `recording.id` (every recording, from when this shipped) — replay.mjs / render.sh fall
// back to the old replay-based path for scripts recorded before that.
//
// Usage: node renderer/from-recording.mjs scripts/<name>.script.json out/<name>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

const [, , scriptPath, outDir] = process.argv;
if (!scriptPath || !outDir) { console.error('usage: from-recording.mjs <script.json> <outDir>'); process.exit(2); }
const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
const recordingId = script.recording?.id;
if (!recordingId) { console.error('this script has no recording.id — render it with renderer/replay.mjs instead'); process.exit(2); }
const recDir = path.join(REPO_ROOT, 'out', '_recordings', recordingId);
if (!fs.existsSync(recDir)) { console.error(`no captured slides at ${recDir} — render.sh should have fallen back to replay.mjs; something called from-recording.mjs directly`); process.exit(2); }

fs.mkdirSync(path.join(outDir, 'slides'), { recursive: true });

const report = {
  name: script.name,
  startedAt: script.recording.recordedAt || script.createdAt || new Date().toISOString(),
  slides: [],
  healed: [],
  failed: [],
  source: 'recording',
};

let slideNo = 0;
let lastUrl = script.environment?.startUrl || null;
let skipped = 0;
for (const step of script.steps) {
  if (step.url) lastUrl = step.url;
  if (step.capture === false) continue;
  const file = step.media?.pre;
  if (!file) { skipped++; continue; } // no capture for this step (older edit, or the upload failed at record time)
  const src = path.join(recDir, file);
  if (!fs.existsSync(src)) { console.warn(`step #${step.index + 1}: expected slide ${file} not found — skipped from the video`); skipped++; continue; }

  slideNo++;
  const outFile = `slide_${String(slideNo).padStart(2, '0')}.png`;
  fs.copyFileSync(src, path.join(outDir, 'slides', outFile));

  // Recorded bbox/viewport are in CSS pixels (getBoundingClientRect); the captured PNG is in the
  // tab's actual device pixels. Scale by the recorded devicePixelRatio so the Ken Burns target and
  // the interactive HTML's hotspot land in the same coordinate space as the image itself.
  const dpr = step.dpr || 1;
  const bbox = step.target?.hint?.bbox;
  const viewport = step.target?.hint?.viewport;
  const target = bbox ? { x: Math.round(bbox.x * dpr), y: Math.round(bbox.y * dpr), width: Math.round(bbox.w * dpr), height: Math.round(bbox.h * dpr) } : null;
  const vp = viewport ? { width: Math.round(viewport.w * dpr), height: Math.round(viewport.h * dpr) } : { width: 1600, height: 900 };

  report.slides.push({
    slide: slideNo,
    step: step.index,
    phase: 'pre',
    file: outFile,
    narration: step.narration || '',
    caption: (script.captionsFromNarration ? step.narration : step.caption) || step.narration || '',
    target,
    viewport: vp,
    route: step.route,
  });
}

if (!report.slides.length) { console.error('no captured slides matched any step — nothing to assemble'); process.exit(4); }

report.finishedAt = new Date().toISOString();
report.finalUrl = lastUrl;
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
console.log(`slides ${report.slides.length}${skipped ? ` (${skipped} step(s) had no capture, skipped)` : ''} · from the recording, no replay · final ${report.finalUrl}`);

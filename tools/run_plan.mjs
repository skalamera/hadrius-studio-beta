#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PROGRESS_FILE = path.resolve(REPO_ROOT, 'data/bulk_record_progress.json');
const WORKFLOWS_FILE = path.resolve(REPO_ROOT, 'data/workflows.json');
const MANUAL_LINKS_FILE = path.resolve(REPO_ROOT, 'data/manual-links.json');
const BRIDGE_URL = 'http://127.0.0.1:8787';

function autoRecordBlocker(wf) {
  const steps = Array.isArray(wf?.steps) ? wf.steps : [];
  if (steps.length < 3) return 'the plan has fewer than 3 steps';
  if (wf?.provisionable === 'structurally-blocked') return 'its prerequisites cannot be set up in this environment';
  const g = wf?.grounding;
  if (!g) return 'the plan has not been verified against the codebase yet';
  if (g.confidence !== 'high') return `the plan is only ${g.confidence || 'partially'}-confidence`;
  if (Array.isArray(g.unverified) && g.unverified.length) return `${g.unverified.length} step(s) could not be pinned to an exact control`;
  return null;
}

function loadProgress() {
  if (fs.existsSync(PROGRESS_FILE)) {
    try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); } catch (_) {}
  }
  return { total: 43, completed: [], skipped: [], failed: [] };
}

function saveProgress(p) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

function renderProgressBar(current, total = 43, barLen = 25) {
  const pct = Math.round((current / total) * 100);
  const filled = Math.min(barLen, Math.round((current / total) * barLen));
  const empty = Math.max(0, barLen - filled);
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  return `[${bar}] ${pct}% (${current}/${total})`;
}

async function api(path, opts = {}) {
  const res = await fetch(`${BRIDGE_URL}${path}`, opts);
  return res.json();
}

export async function runSinglePlan(workflowItem, planIndex = 1, total = 43) {
  const { module: mName, workflow: wf } = workflowItem;
  const title = wf.title;

  console.log(`\n======================================================================`);
  console.log(`${renderProgressBar(planIndex - 1, total)}`);
  console.log(`Executing [${planIndex}/${total}]: [${mName}] "${title}"`);
  console.log(`Start route: ${wf.startRoute} | Steps: ${wf.steps?.length || 0}`);
  console.log(`======================================================================`);

  const startTime = Date.now();
  const queueRes = await api('/workflows/ai-record', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ module: mName, workflow: wf })
  });

  if (!queueRes.ok) {
    console.error(`Queue failed: ${queueRes.error || queueRes.message}`);
    return { ok: false, error: queueRes.error || queueRes.message };
  }

  const key = queueRes.key;
  console.log(`✓ Job queued (key: ${key}). Polling progress…`);

  let lastLogLen = 0;
  let jobResult = null;
  const pollStart = Date.now();
  const maxPollMs = 480000; // 8 minutes max

  while (Date.now() - pollStart < maxPollMs) {
    await new Promise(r => setTimeout(r, 4000));
    const statusRes = await api(`/workflows/ai-record?key=${encodeURIComponent(key)}`);
    if (!statusRes.ok || !statusRes.job) continue;
    const job = statusRes.job;

    const currentLogs = job.log || [];
    if (currentLogs.length > lastLogLen) {
      for (let i = lastLogLen; i < currentLogs.length; i++) {
        const l = currentLogs[i];
        if (l.startsWith('turn') || l.startsWith('Done') || l.startsWith('Saved') || l.startsWith('Attempt') || l.startsWith('Writing') || l.startsWith('Revised')) {
          console.log(`  [record] ${l}`);
        }
      }
      lastLogLen = currentLogs.length;
    }

    if (job.state === 'done') {
      jobResult = job.result;
      break;
    }
    if (job.state === 'failed') {
      const isBug = /does not exist|404|400|500|cannot|refused|blocked|permission|missing|bug|fails to persist/i.test(job.error);
      const progress = loadProgress();
      if (isBug) {
        console.log(`⚠ Flagged as app bug/blocker: ${job.error}`);
        if (!progress.skipped.some(s => s.title === title)) {
          progress.skipped.push({ title, module: mName, reason: job.error });
        }
      } else {
        if (!progress.failed.some(f => f.title === title)) {
          progress.failed.push({ title, module: mName, error: job.error });
        }
      }
      saveProgress(progress);
      console.error(`✗ AI recording failed: ${job.error}`);
      return { ok: false, error: job.error, skipped: isBug };
    }
  }

  if (!jobResult) {
    console.error('Timed out waiting for recording.');
    return { ok: false, error: 'Timed out waiting for recording' };
  }

  const scriptName = jobResult.scriptName || title;
  console.log(`✓ Recording finished: ${jobResult.steps || 'N/A'} steps recorded.`);

  const scriptPath = path.resolve(REPO_ROOT, `scripts/${scriptName}.script.json`);
  console.log(`→ Rendering video via render.sh…`);
  const renderStart = Date.now();
  try {
    execFileSync('bash', [path.resolve(REPO_ROOT, 'render.sh'), scriptPath], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` }
    });
    const renderSec = Math.round((Date.now() - renderStart) / 1000);
    console.log(`✓ Video rendered in ${renderSec}s`);
  } catch (renderErr) {
    console.error(`Render error: ${renderErr.message}`);
  }

  // Update manual-links
  try {
    const ml = JSON.parse(fs.readFileSync(MANUAL_LINKS_FILE, 'utf8'));
    if (!ml.includes(title)) {
      ml.push(title);
      fs.writeFileSync(MANUAL_LINKS_FILE, JSON.stringify(ml, null, 2));
    }
  } catch (_) {}

  // Update progress
  const progress = loadProgress();
  if (!progress.completed.some(c => c.title === title)) {
    const totalSec = Math.round((Date.now() - startTime) / 1000);
    progress.completed.push({ title, module: mName, script: scriptName, durationSec: totalSec });
    saveProgress(progress);
  }

  const processedCount = progress.completed.length + progress.skipped.length;
  console.log(`\n🎉 Completed [${planIndex}/${total}]: "${title}"`);
  console.log(`${renderProgressBar(processedCount, total)}\n`);

  return { ok: true, script: scriptName };
}

async function main() {
  const targetArg = process.argv[2];
  const workflowsData = JSON.parse(fs.readFileSync(WORKFLOWS_FILE, 'utf8'));

  // Build the canonical list of the 43 To Record auto-record eligible workflows
  const canonical43 = [];
  for (const mod of workflowsData.modules || []) {
    const mName = mod.module;
    for (const wf of mod.workflows || []) {
      if (!autoRecordBlocker(wf)) {
        canonical43.push({ module: mName, workflow: wf });
      }
    }
  }

  if (!targetArg) {
    console.log('Listing To Record auto-record workflows:');
    canonical43.forEach((item, idx) => {
      console.log(` ${idx + 1}. [${item.module}] ${item.workflow.title}`);
    });
    return;
  }

  let targetItem = null;
  let targetIndex = -1;
  const num = parseInt(targetArg, 10);
  if (!isNaN(num) && num >= 1 && num <= canonical43.length) {
    targetIndex = num - 1;
    targetItem = canonical43[targetIndex];
  } else {
    targetIndex = canonical43.findIndex(i => i.workflow.title.toLowerCase().includes(targetArg.toLowerCase()));
    if (targetIndex !== -1) targetItem = canonical43[targetIndex];
  }

  if (!targetItem) {
    console.error(`Plan not found matching: ${targetArg}`);
    process.exit(1);
  }

  const res = await runSinglePlan(targetItem, targetIndex + 1, 43);
  if (!res.ok) process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith('run_plan.mjs')) {
  main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

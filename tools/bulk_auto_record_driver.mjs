#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, execSync } from 'node:child_process';

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
  return {
    total: 43,
    completed: [
      { title: 'How to archive a policy', module: 'Testing program', script: 'How-to-archive-a-policy' },
      { title: 'How to raise a corrective action during test review', module: 'Testing program', script: 'How-to-raise-a-corrective-action-during-test-review' }
    ],
    skipped: [],
    failed: []
  };
}

function saveProgress(p) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

function renderProgressBar(current, total, barLen = 25) {
  const pct = Math.round((current / total) * 100);
  const filled = Math.round((current / total) * barLen);
  const empty = barLen - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  return `[${bar}] ${pct}% (${current}/${total})`;
}

async function api(path, opts = {}) {
  const res = await fetch(`${BRIDGE_URL}${path}`, opts);
  return res.json();
}

async function runPlan(moduleName, wf, planNum, totalPlans) {
  const title = wf.title;
  console.log(`\n======================================================================`);
  console.log(`${renderProgressBar(planNum - 1, totalPlans)}`);
  console.log(`Starting [${planNum}/${totalPlans}]: [${moduleName}] "${title}"`);
  console.log(`Start route: ${wf.startRoute} | Steps: ${wf.steps?.length || 0}`);
  console.log(`======================================================================`);

  const startTime = Date.now();
  let key = null;

  try {
    const queueRes = await api('/workflows/ai-record', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ module: moduleName, workflow: wf })
    });

    if (!queueRes.ok) {
      throw new Error(`Queue failed: ${queueRes.error || queueRes.message}`);
    }
    key = queueRes.key;
    console.log(`✓ Job queued (key: ${key}). Polling progress…`);

    // Poll job status
    let lastLogLen = 0;
    let jobResult = null;
    const pollStart = Date.now();
    const maxPollMs = 300000; // 5 min timeout per record

    while (Date.now() - pollStart < maxPollMs) {
      await new Promise(r => setTimeout(r, 4000));
      const statusRes = await api(`/workflows/ai-record?key=${encodeURIComponent(key)}`);
      if (!statusRes.ok || !statusRes.job) continue;
      const job = statusRes.job;

      // Print new logs
      const currentLogs = job.log || [];
      if (currentLogs.length > lastLogLen) {
        for (let i = lastLogLen; i < currentLogs.length; i++) {
          const l = currentLogs[i];
          if (l.startsWith('turn') || l.startsWith('Done') || l.startsWith('Saved') || l.startsWith('Attempt') || l.startsWith('Writing')) {
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
        throw new Error(job.error || 'AI recording failed');
      }
    }

    if (!jobResult) {
      throw new Error(`Timed out waiting for recording after ${Math.round((Date.now() - pollStart)/1000)}s`);
    }

    const scriptName = jobResult.scriptName || title;
    console.log(`✓ Recording finished: ${jobResult.steps || 'N/A'} steps recorded into scripts/${scriptName}.script.json`);

    // Render video
    const scriptPath = path.resolve(REPO_ROOT, `scripts/${scriptName}.script.json`);
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`Script file missing at ${scriptPath}`);
    }

    console.log(`→ Rendering video via render.sh…`);
    const renderStart = Date.now();
    execFileSync('bash', [path.resolve(REPO_ROOT, 'render.sh'), scriptPath], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` }
    });
    const renderSec = Math.round((Date.now() - renderStart) / 1000);
    console.log(`✓ Video rendered in ${renderSec}s`);

    // Mark done in manual-links.json
    try {
      const ml = JSON.parse(fs.readFileSync(MANUAL_LINKS_FILE, 'utf8'));
      if (!ml.includes(title)) {
        ml.push(title);
        fs.writeFileSync(MANUAL_LINKS_FILE, JSON.stringify(ml, null, 2));
      }
    } catch (_) {}

    const totalSec = Math.round((Date.now() - startTime) / 1000);
    return { ok: true, script: scriptName, durationSec: totalSec };
  } catch (err) {
    console.error(`✗ Failed "${title}": ${err.message}`);
    return { ok: false, error: err.message };
  }
}

async function main() {
  const progress = loadProgress();
  const workflowsData = JSON.parse(fs.readFileSync(WORKFLOWS_FILE, 'utf8'));
  const manualLinks = new Set(JSON.parse(fs.readFileSync(MANUAL_LINKS_FILE, 'utf8')));

  const completedTitles = new Set(progress.completed.map(c => c.title));
  const skippedTitles = new Set(progress.skipped.map(s => s.title));

  const allEligible = [];
  for (const mod of workflowsData.modules || []) {
    const mName = mod.module;
    for (const wf of mod.workflows || []) {
      const title = wf.title;
      if (wf.status === 'covered' && !completedTitles.has(title)) continue;
      if (manualLinks.has(title) && !completedTitles.has(title)) continue;
      if (!autoRecordBlocker(wf)) {
        allEligible.push({ module: mName, workflow: wf });
      }
    }
  }

  const total = allEligible.length;
  console.log(`Total Auto-record enabled plans in queue: ${total}`);
  console.log(`Already completed: ${progress.completed.length}`);
  console.log(`Already skipped: ${progress.skipped.length}`);

  for (let i = 0; i < allEligible.length; i++) {
    const { module: mName, workflow: wf } = allEligible[i];
    const title = wf.title;
    const planNum = i + 1;

    if (completedTitles.has(title)) {
      console.log(`[${planNum}/${total}] Already completed: [${mName}] "${title}" ✓`);
      continue;
    }
    if (skippedTitles.has(title)) {
      console.log(`[${planNum}/${total}] Already skipped: [${mName}] "${title}" (prior bug/blocker)`);
      continue;
    }

    const res = await runPlan(mName, wf, planNum, total);
    if (res.ok) {
      progress.completed.push({ title, module: mName, script: res.script, durationSec: res.durationSec });
      completedTitles.add(title);
      saveProgress(progress);
      console.log(`\n🎉 Completed [${planNum}/${total}]: "${title}" in ${res.durationSec}s`);
      console.log(`${renderProgressBar(progress.completed.length, total)}\n`);
    } else {
      // Check if it is an app bug or fatal blocker
      const isBug = /does not exist|404|400|500|cannot|refused|blocked|permission|missing/i.test(res.error);
      if (isBug) {
        console.log(`⚠ Flagging as app bug/blocker: ${res.error}`);
        progress.skipped.push({ title, module: mName, error: res.error });
        skippedTitles.add(title);
      } else {
        progress.failed.push({ title, module: mName, error: res.error, at: new Date().toISOString() });
      }
      saveProgress(progress);
    }

    // Small pause between runs to let browser contexts completely drain
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('\n======================================================================');
  console.log('ALL ELIGIBLE PLANS PROCESSED');
  console.log(`Completed: ${progress.completed.length}`);
  console.log(`Skipped (Bugs): ${progress.skipped.length}`);
  console.log(`Failed: ${progress.failed.length}`);
  console.log('======================================================================');
}

main().catch(err => {
  console.error('Fatal runner error:', err);
  process.exit(1);
});

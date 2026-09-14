import fs from 'node:fs';
import path from 'node:path';

const TARGET_MODULES = [
  'branches',
  'communications',
  'marketing',
  'account surveillance'
];

const BRIDGE_URL = 'http://localhost:8787';
const PROGRESS_FILE = path.resolve('data/enhance-progress.json');
const CONCURRENCY = 3;

const slug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const normalizeTitle = (val) => slug(val).replace(/^(how-to|how-do-i)-/, '');
const articleMatches = (workflow, article) => {
  const a = normalizeTitle(article.title), w = normalizeTitle(workflow.title);
  return a === w || a.includes(w) || w.includes(a);
};

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    }
  } catch (_) {}
  return {};
}

function saveProgress(progress) {
  try {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
  } catch (e) {
    console.error('Failed to write progress:', e.message);
  }
}

async function getOpportunities() {
  const [wfRes, pylonRes] = await Promise.all([
    fetch(`${BRIDGE_URL}/workflows`).then(r => r.json()),
    fetch(`${BRIDGE_URL}/pylon/articles`).then(r => r.json())
  ]);

  const manualLinks = new Set(wfRes.manualLinks || []);
  const dismissed = new Set(wfRes.dismissed || []);

  const opportunities = [];

  for (const mod of wfRes.modules) {
    const modLower = mod.module.toLowerCase();
    if (!TARGET_MODULES.includes(modLower)) continue;

    let articles = [];
    if (pylonRes?.modules) {
      for (const [k, v] of Object.entries(pylonRes.modules)) {
        if (k.toLowerCase() === modLower) {
          articles = v.articles || [];
          break;
        }
      }
    }

    const unlinked = (mod.workflows || []).filter(w => {
      const isAuto = articles.some(a => articleMatches(w, a));
      const isManual = manualLinks.has(w.title);
      const isDismissed = dismissed.has(w.title);
      return !isAuto && !isManual && !isDismissed;
    });

    for (const w of unlinked) {
      opportunities.push({
        module: mod.module,
        workflow: w
      });
    }
  }

  return opportunities;
}

async function enhanceAndAccept(item, idx, total, progress) {
  const key = `${item.module}::${item.workflow.title}`;
  if (progress[key]?.status === 'completed') {
    console.log(`[${idx + 1}/${total}] [SKIP] Already enhanced: [${item.module}] "${item.workflow.title}"`);
    return { ok: true, skipped: true };
  }

  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`[${idx + 1}/${total}] [START] (Attempt ${attempt}/${maxAttempts}) Enhancing plan: [${item.module}] "${item.workflow.title}"...`);
    const t0 = Date.now();

    try {
      // 1. POST /workflows/enhance
      const enhanceRes = await fetch(`${BRIDGE_URL}/workflows/enhance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          module: item.module,
          workflow: item.workflow
        })
      });

      if (!enhanceRes.ok) {
        const text = await enhanceRes.text();
        throw new Error(`Enhance HTTP ${enhanceRes.status}: ${text}`);
      }

      const enhanceData = await enhanceRes.json();
      if (!enhanceData.ok || !enhanceData.plan) {
        throw new Error(enhanceData.error || 'No plan returned from enhance');
      }

      const plan = enhanceData.plan;
      const enhanceDuration = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[${idx + 1}/${total}] [ENHANCED] "${item.workflow.title}" in ${enhanceDuration}s (${plan.steps?.length || 0} steps). Accepting & replacing...`);

      // 2. POST /workflows/opportunity (Accept & Replace Plan)
      const oppRes = await fetch(`${BRIDGE_URL}/workflows/opportunity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          module: item.module,
          workflow: plan
        })
      });

      if (!oppRes.ok) {
        const text = await oppRes.text();
        throw new Error(`Opportunity HTTP ${oppRes.status}: ${text}`);
      }

      const oppData = await oppRes.json();
      if (!oppData.ok) {
        throw new Error(oppData.error || 'Failed to save opportunity');
      }

      const totalDuration = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[${idx + 1}/${total}] [SAVED] ✓ Successfully enhanced & replaced: [${item.module}] "${item.workflow.title}" (${plan.steps?.length || 0} steps, ${totalDuration}s total)`);

      progress[key] = {
        module: item.module,
        title: item.workflow.title,
        stepsCount: plan.steps?.length || 0,
        sources: plan.sources || [],
        status: 'completed',
        timestamp: new Date().toISOString()
      };
      saveProgress(progress);

      return { ok: true, plan };
    } catch (err) {
      console.error(`[${idx + 1}/${total}] [ERROR attempt ${attempt}] Failed [${item.module}] "${item.workflow.title}": ${err.message}`);
      if (attempt === maxAttempts) {
        progress[key] = {
          module: item.module,
          title: item.workflow.title,
          error: err.message,
          status: 'failed',
          timestamp: new Date().toISOString()
        };
        saveProgress(progress);
        return { ok: false, error: err.message };
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function main() {
  console.log('Fetching opportunities from Hadrius Studio bridge...');
  const opps = await getOpportunities();
  const progress = loadProgress();

  const total = opps.length;
  console.log(`Found ${total} recording opportunities in Branches, Communications, Marketing, Account surveillance.`);
  console.log(`Starting worker pool with concurrency=${CONCURRENCY}...\n`);

  let currentIndex = 0;

  async function worker() {
    while (currentIndex < total) {
      const idx = currentIndex++;
      const item = opps[idx];
      await enhanceAndAccept(item, idx, total, progress);
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  const completed = Object.values(progress).filter(p => p.status === 'completed').length;
  const failed = Object.values(progress).filter(p => p.status === 'failed').length;

  console.log('\n=============================================');
  console.log(`Finished processing recording opportunities!`);
  console.log(`Completed: ${completed}`);
  console.log(`Failed:    ${failed}`);
  console.log(`Total:     ${total}`);
  console.log('=============================================');
}

main().catch(err => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});

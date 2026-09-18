#!/usr/bin/env node
// KB Studio — local AI bridge for the recorder extension.
// Chrome extensions can't spawn processes, so this tiny HTTP server sits between the side panel
// and the `claude` CLI, running under YOUR authenticated seat (Hadrius enterprise) — no API key,
// no extra cost beyond your existing Claude Code plan.
//
// Run: node tools/ai-bridge.mjs   (leave it running while using the side panel's "Draft with AI")
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ALLOWED_MODULES, canonicalModule, claudeEnv, extractJson, GROUNDING_CONTRACT, assessGrounding } from './coverage-scan.mjs';
import { pylonUploadAttachment, pylonCreateArticle, pylonCollectionForModule, pylonListArticles, pylonArticleUrl, PYLON_MODULE_COLLECTION_MAP, PYLON_KNOWLEDGE_BASE_ID, PYLON_COLLECTION_ID, PYLON_OTHER_COLLECTION_ID } from './pylon.mjs';
import { googleDriveConfigured, googleDriveUploadVideo, checkGoogleDrive } from './gdrive.mjs';

const PORT = process.env.KBS_BRIDGE_PORT || 8787;
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE_DIR = process.env.KBS_PROFILE_DIR || path.join(REPO_ROOT, '.browser-profile');

// ---- .env (gitignored) — holds the shared-library secret so it never lives in extension code ----
// Only the keys the bridge itself uses are imported. ~/.hermes/.env in particular is shared with
// other tools and carries ANTHROPIC_API_KEY etc.; if those reached process.env they would be
// inherited by every `claude` we spawn and override the operator's `claude login` session.
const DOTENV_KEYS = new Set(['STUDIO_LIBRARY_URL', 'STUDIO_SHARED_SECRET', 'STUDIO_USER', 'GEMINI_API_KEY', 'PYLON_API_TOKEN', 'PYLON_KB_ID', 'PYLON_COLLECTION_ID', 'PYLON_OTHER_COLLECTION_ID', 'PYLON_AUTHOR_USER_ID', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_DRIVE_FOLDER_ID']);
let LIBRARY_SECRET = (process.env.STUDIO_SHARED_SECRET || '').trim();
let GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();

function loadDotEnv() {
  const parseEnv = (p) => {
    if (!fs.existsSync(p)) return;
    for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('='); if (eq < 0) continue;
      const k = line.slice(0, eq).trim(); let v = line.slice(eq + 1).trim();
      if (!DOTENV_KEYS.has(k) && !k.startsWith('KBS_')) continue;
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (v) process.env[k] = v;
    }
  };
  parseEnv(path.join(REPO_ROOT, '.env'));
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) parseEnv(path.join(home, '.hermes/.env'));
  LIBRARY_SECRET = (process.env.STUDIO_SHARED_SECRET || '').trim();
  GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
}
loadDotEnv();
const LIBRARY_URL = process.env.STUDIO_LIBRARY_URL || 'https://pylon-webhook-service.vercel.app/api/studio-beta-scripts';
const WHOAMI = process.env.STUDIO_USER || process.env.USER || process.env.USERNAME || 'unknown';
// Dedicated beta endpoints in Neon so beta workflows never overlap with the original studio tables.
const COVERAGE_URL = LIBRARY_URL.includes('studio-beta-scripts')
  ? LIBRARY_URL.replace('studio-beta-scripts', 'studio-beta-coverage')
  : LIBRARY_URL.replace(/\/api\/studio-scripts.*/, '/api/studio-beta-coverage');
const HEALTH_CHECK_URL = LIBRARY_URL.replace(/\/api\/studio.*/, '/api/studio-health-check');
let coverageScan = { running: false, startedAt: null, finishedAt: null, log: [], result: null, error: null };
let liteScan = { running: false, startedAt: null, finishedAt: null, log: [], error: null };
const WORKFLOWS_FILE = path.join(REPO_ROOT, 'data', 'workflows.json');
const MANUAL_LINKS_FILE = path.join(REPO_ROOT, 'data', 'manual-links.json');
const DISMISSED_WORKFLOWS_FILE = path.join(REPO_ROOT, 'data', 'dismissed-workflows.json');

let cachedCoverage = { at: 0, data: null };
function invalidateCoverageCache() {
  cachedCoverage = { at: 0, data: null };
}
async function getCachedCoverage({ maxAgeMs = 90000, fresh = false } = {}) {
  if (!fresh && cachedCoverage.data && (Date.now() - cachedCoverage.at < maxAgeMs)) {
    return cachedCoverage.data;
  }
  const data = await libraryFetch('GET', null, null, COVERAGE_URL);
  cachedCoverage = { at: Date.now(), data };
  return data;
}

function candSlug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 140);
}

// The plan proper — what the shared library stores on each candidate row so every install sees the
// same steps without a git pull. Coverage state (status, linked script, dismissed) is deliberately
// not part of it; that lives in the row's own columns.
const PLAN_FIELDS = ['purpose', 'startRoute', 'steps', 'sources', 'prerequisites', 'provisionable', 'blockerReason', 'suggestedSetupSteps', 'fileFixtureKind', 'evidence', 'trigger', 'priority', 'grounding'];

// Auto-record only makes sense when every step was verified against the source: a step the
// planner could not pin to an exact control is exactly where the browser agent gets stuck. The
// same rule gates the button in the panel and the /workflows/ai-record endpoint.
function autoRecordBlocker(wf) {
  const steps = Array.isArray(wf?.steps) ? wf.steps : [];
  if (steps.length < 3) return 'the plan has fewer than 3 steps';
  if (wf?.provisionable === 'structurally-blocked') return 'its prerequisites cannot be set up in this environment';
  const g = wf?.grounding;
  if (!g) return 'the plan has not been verified against the codebase yet — open View plan and run Enhance';
  if (g.confidence !== 'high') return `the plan is only ${g.confidence || 'partially'}-confidence`;
  if (Array.isArray(g.unverified) && g.unverified.length) return `${g.unverified.length} step(s) could not be pinned to an exact control`;
  return null;
}
function planPayload(wf) {
  if (!wf || !Array.isArray(wf.steps) || !wf.steps.length) return null;
  const plan = {};
  for (const f of PLAN_FIELDS) if (wf[f] !== undefined) plan[f] = wf[f];
  return plan;
}
// Keys whose local-only plan this process has already pushed to the shared library, so a busy
// panel polling GET /workflows doesn't re-upload the same plans every 90 seconds.
const pushedPlanKeys = new Set();

/** True when the shared row carries a plan that is newer than what this machine has locally. */
function sharedPlanIsNewer(sharedItem, localWf) {
  if (!sharedItem?.plan?.steps?.length) return false;
  if (!localWf?.steps?.length) return true;
  const sharedAt = Date.parse(sharedItem.plan_updated_at || '') || 0;
  const localAt = Date.parse(localWf.planUpdatedAt || '') || 0;
  return sharedAt > localAt;
}

function readManualLinks() {
  try { return fs.existsSync(MANUAL_LINKS_FILE) ? JSON.parse(fs.readFileSync(MANUAL_LINKS_FILE, 'utf8')) : []; }
  catch (_) { return []; }
}
function writeManualLinks(links) {
  try {
    fs.mkdirSync(path.dirname(MANUAL_LINKS_FILE), { recursive: true });
    fs.writeFileSync(MANUAL_LINKS_FILE, JSON.stringify(links, null, 2));
  } catch (_) {}
}

function readDismissedWorkflows() {
  try { return fs.existsSync(DISMISSED_WORKFLOWS_FILE) ? JSON.parse(fs.readFileSync(DISMISSED_WORKFLOWS_FILE, 'utf8')) : []; }
  catch (_) { return []; }
}
function writeDismissedWorkflows(list) {
  try {
    fs.mkdirSync(path.dirname(DISMISSED_WORKFLOWS_FILE), { recursive: true });
    fs.writeFileSync(DISMISSED_WORKFLOWS_FILE, JSON.stringify(list, null, 2));
  } catch (_) {}
}

// ---- Claude CLI login state. Every AI feature shells out to `claude`, whose OAuth login is separate
// from the desktop app's and expires silently. Check it cheaply (~0.2s) and cache, so the panel can
// show the fix up front and jobs fail fast with it instead of a bare OAuth error deep in a log.
const CLAUDE_LOGIN_HINT = 'The Claude CLI on this machine is signed out. In a terminal run:  claude login   (finish the browser prompt), then try again — no restart needed.';
const CLAUDE_MISSING_HINT = 'The `claude` CLI is not installed or not on PATH for the bridge. Run ./setup.sh in the kb-studio folder.';
let claudeAuth = { loggedIn: null, checkedAt: 0, detail: null };
function checkClaudeAuth({ maxAgeMs = 60000 } = {}) {
  if (Date.now() - claudeAuth.checkedAt < maxAgeMs) return Promise.resolve(claudeAuth);
  return new Promise((resolve) => {
    const child = execFile('claude', ['auth', 'status'], { timeout: 10000, env: claudeEnv() }, (err, stdout) => {
      let loggedIn = null, detail = null;
      if (err?.code === 'ENOENT') { loggedIn = false; detail = CLAUDE_MISSING_HINT; }
      else {
        try { loggedIn = !!JSON.parse(stdout).loggedIn; } catch { loggedIn = err ? false : null; }
        if (loggedIn === false) detail = CLAUDE_LOGIN_HINT;
      }
      claudeAuth = { loggedIn, checkedAt: Date.now(), detail };
      resolve(claudeAuth);
    });
    child.stdin?.end();
  });
}
// \b guards keep prose like "two dialog instances" from matching "log in" and spuriously
// flagging the CLI as signed out on an ordinary workflow failure.
const isClaudeAuthError = (msg) => /authenticate|OAuth|not logged in|\blog ?in\b|session expired/i.test(String(msg));
/** Append the fix to an auth failure message and flip the cached state so the panel's banner appears. */
function withAuthHint(msg) {
  const s = String(msg);
  if (!isClaudeAuthError(s)) return s;
  claudeAuth = { loggedIn: false, checkedAt: Date.now(), detail: CLAUDE_LOGIN_HINT };
  return `${s} — ${CLAUDE_LOGIN_HINT}`;
}
/** Throw with the fix if the CLI is signed out — call before starting anything that needs `claude`. */
async function requireClaudeAuth() {
  const a = await checkClaudeAuth({ maxAgeMs: 0 });
  if (a.loggedIn === false) {
    if (GEMINI_API_KEY || (process.env.GEMINI_API_KEY || '').trim()) {
      console.warn('Claude CLI is signed out; operations will fall back to gemini-3.8-flash.');
      return;
    }
    throw new Error(a.detail);
  }
}

// ---- hadrius-codebase MCP connection state — separate from the Claude CLI login above: this is
// its own OAuth session (`claude mcp login hadrius-codebase`), so a signed-in `claude` CLI can
// still have a dead/disconnected codebase MCP, silencing every source-grounded plan and consult.
const CODEBASE_MCP_LOGIN_HINT = 'The hadrius-codebase MCP isn\'t connected. In a terminal run:  claude mcp login hadrius-codebase   (finish the browser prompt), then try again — no restart needed.';
const CODEBASE_MCP_MISSING_HINT = 'The hadrius-codebase MCP isn\'t registered with the Claude CLI. In a terminal run:  claude mcp add --transport http hadrius-codebase https://mcp.hadriusapi.com/codebase --scope user';
// ---- App version + "is this install behind origin/main" — shown under the wordmark in the panel
// header. Reads package.json rather than a hand-maintained constant: the /health endpoint used to
// hardcode '0.1.1' while package.json said '0.1.0', silently drifting apart.
const LOCAL_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
})();

function execGit(args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: REPO_ROOT, timeout: 20000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).split('\n')[0]));
      resolve(stdout.trim());
    });
  });
}

let updateState = { checkedAt: 0, upToDate: null, latestVersion: null, commitsBehind: null, detail: null };
/** Compares local HEAD to origin/main by commit SHA, not just package.json's version string — a
 * real change can land without a version bump, and we'd rather say "5 commits behind" honestly
 * than nothing at all. */
async function checkForUpdate({ maxAgeMs = 5 * 60000 } = {}) {
  if (Date.now() - updateState.checkedAt < maxAgeMs) return updateState;
  try {
    await execGit(['fetch', 'origin', 'main', '--quiet']);
    const [localSha, remoteSha] = await Promise.all([execGit(['rev-parse', 'HEAD']), execGit(['rev-parse', 'origin/main'])]);
    const upToDate = localSha === remoteSha;
    let latestVersion = null, commitsBehind = 0;
    if (!upToDate) {
      commitsBehind = parseInt(await execGit(['rev-list', '--count', `${localSha}..origin/main`]), 10) || 0;
      try { latestVersion = JSON.parse(await execGit(['show', 'origin/main:package.json'])).version || null; } catch (_) {}
    }
    updateState = { checkedAt: Date.now(), upToDate, latestVersion, commitsBehind, detail: null };
  } catch (e) {
    // Offline, no network, or not a git checkout yet (zip install before the first update.sh run)
    // — say "couldn't check" rather than false-alarming "update available".
    updateState = { checkedAt: Date.now(), upToDate: null, latestVersion: null, commitsBehind: null, detail: String(e.message || e).slice(0, 160) };
  }
  return updateState;
}

let codebaseMcpState = { connected: null, checkedAt: 0, detail: null };
function checkCodebaseMcp({ maxAgeMs = 60000 } = {}) {
  if (Date.now() - codebaseMcpState.checkedAt < maxAgeMs) return Promise.resolve(codebaseMcpState);
  return new Promise((resolve) => {
    // Probe hadrius-codebase directly via `claude mcp get hadrius-codebase` (~1s) rather than
    // `claude mcp list` (10-15s+), which health-checks 60+ other configured third-party servers
    // and regularly exceeded the 15s timeout, truncating stdout before hadrius-codebase was parsed.
    const child = execFile('claude', ['mcp', 'get', 'hadrius-codebase'], { timeout: 15000, env: claudeEnv() }, (err, stdout, stderr) => {
      let connected = null, detail = null;
      if (err?.code === 'ENOENT') { connected = false; detail = CLAUDE_MISSING_HINT; }
      else {
        const out = `${stdout || ''}\n${stderr || ''}`;
        if (/No MCP server named/i.test(out)) {
          connected = false;
          detail = CODEBASE_MCP_MISSING_HINT;
        } else {
          connected = /✔|connected/i.test(out) && !/✗|✘|failed|disconnected|needs authentication/i.test(out);
          if (!connected) detail = CODEBASE_MCP_LOGIN_HINT;
        }
      }
      codebaseMcpState = { connected, checkedAt: Date.now(), detail };
      resolve(codebaseMcpState);
    });
    child.stdin?.end();
  });
}

// ai-record.mjs compiles its in-page helpers with new Function() at import time, so a bad edit there
// (e.g. an unescaped regex inside the template string) throws on load — and without this wrapper that
// surfaced as a cryptic per-workflow "Invalid regular expression" on every plan and every job. Name
// the real cause instead, and check once at startup so it shows in the bridge log immediately.
async function loadAiRecord() {
  try { return await import('./ai-record.mjs'); }
  catch (e) { throw new Error(`tools/ai-record.mjs failed to load (fix the file, then restart the bridge): ${String(e?.message || e).split('\n')[0]}`); }
}
loadAiRecord().then(() => console.log('ai-record.mjs loaded OK')).catch((e) => console.error('!!', e.message));

/** Same sanitizer the side panel uses for script names (extension/sidepanel.js safeName). */
function safeName(name) { return String(name || 'untitled').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled'; }

/** Fetch one library script by name, or null. */
async function libraryGetByName(name) {
  try { const r = await libraryFetch('GET', { name }); return r.item || (Array.isArray(r.items) ? r.items.find((i) => i.name === name) : null) || null; }
  catch { return null; }
}

/** Pylon article id -> { scriptName, driveVideoUrl }, for the panel's Recorded tab "Load script"
 * button and its Google Drive video link. */
function buildArticleScriptIndex() {
  const index = new Map();
  const scriptsDir = path.join(REPO_ROOT, 'scripts');
  if (!fs.existsSync(scriptsDir)) return index;
  for (const f of fs.readdirSync(scriptsDir)) {
    if (!f.endsWith('.script.json')) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(scriptsDir, f), 'utf8'));
      if (s.pylonArticleId) index.set(String(s.pylonArticleId), { scriptName: s.name || f.replace('.script.json', ''), driveVideoUrl: s.driveVideoUrl || null });
    } catch (_) {}
  }
  return index;
}

/**
 * A recipe-backed script has no steps to read a startUrl from, so any caller that builds one from
 * scratch (or from stale in-memory state — see the panel's toScript()) can end up sending null.
 * render.sh doesn't care (from-recipe.mjs ignores environment entirely), but there's no reason to
 * let a known-good value get overwritten with null in the library/local mirror. Best-effort: keep
 * whatever the script already had if the caller didn't supply one.
 */
async function backfillRecipeStartUrl(script) {
  if (script.environment?.startUrl) return script;
  if (!findRecipeForScriptName(safeName(script.name))) return script;
  const prior = (await libraryGetByName(safeName(script.name)))?.script?.environment?.startUrl;
  if (prior) script.environment = { ...(script.environment || {}), startUrl: prior };
  return script;
}

/**
 * Save a script to the shared library and mirror it into scripts/ so render.sh / cron can use it
 * offline. Single place for that pairing — used by the /library route and the AI recorder.
 */
async function saveScript(script, extra = {}) {
  // Capture the real display title BEFORE sanitizing name into a filename-safe slug — safeName()
  // turns any non-word character (including an apostrophe) into a hyphen, so "policy's" became the
  // slug "policy-s", and every downstream reader that falls back to script.name (the video title
  // card, the Pylon article title) rendered it as "Policy S" instead of "Policy's".
  if (!script.title) script.title = script.name;
  script.name = safeName(script.name);
  await backfillRecipeStartUrl(script);
  const out = await libraryFetch('POST', null, { ...extra, script, updated_by: WHOAMI });
  try { fs.mkdirSync(path.join(REPO_ROOT, 'scripts'), { recursive: true }); fs.writeFileSync(path.join(REPO_ROOT, 'scripts', `${out.item.name}.script.json`), JSON.stringify(script, null, 2)); } catch (_) {}
  return out;
}

const TAXONOMY_PATH = path.join(REPO_ROOT, 'tools/coverage-taxonomy.json');
/**
 * A class-C/B workflow with a finished Phase 1 recipe (tools/recipe-*.mjs) can't be usefully
 * AI-recorded: its own precondition is consumed by the recording, so a captured replay breaks the
 * next time it runs (see render.sh's identical lookup, and README's "Phase 1 recipes" section).
 * Read fresh every call — the taxonomy is hand-edited between renders, not just at bridge startup.
 */
function findDoneRecipe(key) {
  if (!key) return null;
  try {
    const d = JSON.parse(fs.readFileSync(TAXONOMY_PATH, 'utf8'));
    return d.items.find((i) => i.key === key && i.status === 'done' && i.recipe)?.recipe || null;
  } catch { return null; }
}
/** Same lookup, keyed by script name instead of coverage key — mirrors render.sh's own match exactly. */
function findRecipeForScriptName(name) {
  if (!name) return null;
  try {
    const d = JSON.parse(fs.readFileSync(TAXONOMY_PATH, 'utf8'));
    const n = String(name).toLowerCase();
    return d.items.find((i) => i.status === 'done' && i.recipe && i.key.toLowerCase().endsWith(n))?.recipe || null;
  } catch { return null; }
}

/**
 * Is "Create with AI" allowed to run for this workflow? Opt-in by design: the agent burns 20-40
 * browser turns per attempt, and an unvetted workflow usually spends all of them discovering a
 * blocker a human would have seen instantly. So the default is "unvalidated" — no button, record it
 * by hand — and a workflow only becomes eligible once someone has actually seen it work.
 *
 *   ok           explicit ai_record:"ok" in the taxonomy, or a finished Phase 1 recipe (those never
 *                drive a browser at all — the job short-circuits to writing the trigger stub)
 *   blocked      explicit ai_record:"blocked" (ai_note says why), or tagged `file`: the agent's whole
 *                action set is click/type/press/wait, so an <input type="file"> is unreachable
 *   unvalidated  nobody has confirmed it works yet — treated as manual-only
 */
function aiRecordEligibility(key) {
  if (!key) return { mode: 'unvalidated', note: null };
  try {
    const d = JSON.parse(fs.readFileSync(TAXONOMY_PATH, 'utf8'));
    const it = d.items.find((i) => i.key === key);
    if (!it) return { mode: 'unvalidated', note: null };
    if (it.ai_record === 'ok' || it.ai_record === 'blocked') return { mode: it.ai_record, note: it.ai_note || null };
    if (it.status === 'done' && it.recipe) return { mode: 'ok', note: `Runs from its own recipe (${it.recipe}) — no browser driving.` };
    // `file`-tagged workflows used to be auto-blocked, because the agent's action set could not
    // reach a file picker at all. It can now (tools/upload-fixtures.mjs), so the mechanical barrier
    // is gone — but "can attach a file" is not "can finish the workflow", so they fall back to
    // unvalidated like anything else nobody has watched succeed yet.
    return { mode: 'unvalidated', note: null };
  } catch { return { mode: 'unvalidated', note: null }; }
}

/**
 * The shared coverage table may hold rows from older, broader scans. Filter every response to the
 * allow-list (tools/coverage-scan.mjs ALLOWED_MODULES) and recompute the summary from what's left,
 * so the panel's badge, progress bar and list all agree — and hand the panel the list to group by.
 */
// ---- Workflow plans: a source-code-derived, step-by-step plan per coverage item, generated in the
// background as soon as a workflow appears (after a scan, or on first panel load) so Create with AI
// and Record this both have it ready. The shared coverage API drops unknown fields, so plans live
// here (.coverage-plans.json) and are merged into /coverage responses.
const PLANS_FILE = path.join(REPO_ROOT, '.coverage-plans.json');
let plans = {}; // key -> { plan, generatedAt, title, model }
try { plans = JSON.parse(fs.readFileSync(PLANS_FILE, 'utf8')); } catch (_) {}
function savePlans() { try { fs.writeFileSync(PLANS_FILE, JSON.stringify(plans, null, 2)); } catch (e) { console.warn('could not save plans:', e.message); } }
// `model` is recorded because a plan's worth depends entirely on who wrote it: Claude here has the
// read-only hadrius-codebase MCP and derives steps from real source, while the Gemini fallback has no
// tool access at all. Without this field a cache of mixed provenance looks uniform, and "regenerate
// the weak ones" has no answer but the timestamps.
function setPlan(key, plan, title) { plans[key] = { plan, generatedAt: new Date().toISOString(), title, model: plan?.model || null, turns: plan?.turns ?? null }; savePlans(); }

const PLAN_CONCURRENCY = 2;
const planQueue = []; // items
const planQueued = new Set(); // keys in queue or in flight
let planActive = 0;
const planFailed = {}; // key -> error (last attempt)
function queuePlans(items) {
  let n = 0;
  for (const it of items) {
    // it.status only reads "dismissed" when the item ALSO has no matched script — once any script
    // is matched (even the wrong one, from the remote service's own fuzzy fallback), status
    // reflects that script's health instead, and a dismissed item would keep having plans
    // (re)generated for it forever. it.dismissed is the actual, reliable flag.
    if (!it?.key || plans[it.key] || planQueued.has(it.key) || it.dismissed) continue;
    planQueued.add(it.key); planQueue.push(it); n++;
  }
  if (n) pumpPlanQueue();
  return n;
}
function pumpPlanQueue() {
  while (planActive < PLAN_CONCURRENCY && planQueue.length) {
    const it = planQueue.shift();
    planActive++;
    (async () => {
      try {
        const { planFromCodebase } = await loadAiRecord();
        const plan = await planFromCodebase(it);
        setPlan(it.key, plan, it.title);
        delete planFailed[it.key];
        const grounded = (plan.turns ?? 0) > 1; // 1 turn = answered without opening the repo
        console.log(`plan ready: ${it.title} (${plan.steps?.length || 0} steps, ${plan.model || '?'}, ${plan.turns ?? '?'} turns)${grounded ? '' : '  <-- NOT codebase-grounded'}`);
      } catch (e) {
        planFailed[it.key] = withAuthHint(e?.message || e);
        console.warn(`plan failed: ${it.title}: ${planFailed[it.key]}`);
      } finally {
        planQueued.delete(it.key); planActive--;
        pumpPlanQueue();
      }
    })();
  }
}
const planStatus = () => ({ running: planActive, queued: planQueue.length, ready: Object.keys(plans).length, failed: Object.keys(planFailed).length });

function filterCoverage(cov) {
  const items = (cov.items || [])
    .map((it) => ({ ...it, module: canonicalModule(it.module) }))
    .filter((it) => it.module)
    .map((it) => ({ ...it, plan: plans[it.key]?.plan || null, plan_at: plans[it.key]?.generatedAt || null, plan_pending: planQueued.has(it.key), plan_error: planFailed[it.key] || null }))
    .map((it) => { const e = aiRecordEligibility(it.key); return { ...it, ai_record: e.mode, ai_note: e.note }; });
  // ai_record only governs whether the AGENT may attempt a workflow — it says nothing about whether
  // the workflow is worth recording. A blocked one is still a real coverage gap a human can fill by
  // hand, so it stays in the list and in these totals; only an explicit dismiss removes it.
  //
  // Filter on it.dismissed, NOT it.status === 'dismissed': the remote service only reports that
  // status when an item ALSO has no matched script. Once any script is matched — even the wrong
  // one, via the service's own fuzzy fallback matching — status reflects that script's health
  // instead, and a genuinely-dismissed item would keep inflating the covered/untested/etc. totals
  // and never disappear from the panel's default view.
  const active = items.filter((it) => !it.dismissed);
  const count = (s) => active.filter((it) => it.status === s).length;
  // dismissed is items.length - active.length (the true count by the flag), not passed through from
  // cov.summary — the remote service's own summary field undercounts for the identical reason.
  const summary = { ...(cov.summary || {}), total: active.length, covered: count('covered'), attention: count('attention'), untested: count('untested'), missing: count('missing'), dismissed: items.length - active.length };
  const modules = ALLOWED_MODULES.filter((m) => items.some((it) => it.module === m));
  return { ...cov, items, summary, modules, allowed_modules: ALLOWED_MODULES, plans: planStatus() };
}

// ---- AI-driven recording: one job per coverage key, small concurrency queue so several can run
// side by side (each gets its own isolated browser + cloned login profile) without overloading
// the machine or the `claude` CLI.
const AI_RECORD_CONCURRENCY = 3;
const AI_JOB_TTL_MS = 30 * 60 * 1000; // finished jobs are reported for this long, then evicted
const aiJobs = new Map(); // key -> { state: 'queued'|'running'|'done'|'failed', startedAt, finishedAt, log, error, result, item, controller }
const aiQueue = [];
let aiActive = 0;

const aiBusy = (j) => j.state === 'queued' || j.state === 'running';
function aiLog(key, m) { const j = aiJobs.get(key); if (!j) return; j.log.push(m); if (j.log.length > 300) j.log.shift(); }
function evictAiJobs() {
  const cutoff = Date.now() - AI_JOB_TTL_MS;
  for (const [key, j] of aiJobs) if (!aiBusy(j) && j.finishedAt && Date.parse(j.finishedAt) < cutoff) aiJobs.delete(key);
}
function aiJobView(j, { full = false } = {}) {
  // The list view stays light; a single job's view returns the whole retained log so a failed run
  // can be diagnosed from its first turns, not just its last 40 lines.
  return { state: j.state, running: j.state === 'running', queued: j.state === 'queued', startedAt: j.startedAt, finishedAt: j.finishedAt, log: full ? j.log.slice() : j.log.slice(-40), error: j.error, result: j.result };
}

// Each concurrent job runs in its own persistent browser profile (.browser-profile-ai-<slot>) with
// its own Hadrius sign-in — never a copy of the renderer's profile, since Cognito's refresh-token
// rotation makes two profiles sharing one login invalidate each other.
const aiSlots = Array.from({ length: AI_RECORD_CONCURRENCY }, (_, i) => i + 1);

function pumpAiQueue() {
  evictAiJobs();
  while (aiActive < AI_RECORD_CONCURRENCY && aiQueue.length && aiSlots.length) {
    const key = aiQueue.shift();
    const job = aiJobs.get(key);
    if (!job || job.state !== 'queued') continue;
    aiActive++;
    const slot = aiSlots.shift();
    job.state = 'running'; job.startedAt = new Date().toISOString();
    (async () => {
      const { signal } = job.controller;
      const recipe = findDoneRecipe(job.item?.key);
      try {
        if (recipe) {
          // This workflow already has a hand-written Phase 1 recipe — the same one render.sh
          // prefers over any recorded script. AI-driven exploration would just record a replay
          // that breaks the moment the recipe's precondition is consumed again, so skip straight
          // to the minimal empty-step trigger script (render.sh dispatches on script name + this
          // taxonomy entry, not on the script's own steps/environment — see renderer/from-recipe.mjs).
          aiLog(key, `This workflow already has a recipe (${recipe}) — creating a trigger script instead of AI-recording it.`);
          signal.throwIfAborted();
          // Prefer the coverage item's own linked_script over a fresh title-derived guess — the
          // title can drift (a re-scan rewording it, a manual rename) after the two were linked,
          // and re-deriving the name from scratch every time would silently orphan that link.
          const linkedName = job.item.linked_script ? safeName(job.item.linked_script) : null;
          const desired = safeName(job.item.title);
          let out;
          const existing = (linkedName && await libraryGetByName(linkedName)) || await libraryGetByName(desired);
          if (existing) {
            aiLog(key, `A script named "${existing.name}" already exists — leaving it as-is and linking to it.`);
            out = { item: { name: existing.name } };
          } else {
            out = await saveScript({
              version: 1,
              name: desired,
              captionsFromNarration: false,
              createdAt: new Date().toISOString(),
              environment: { startUrl: `https://app.hadrius.com${job.item.start_route || ''}?company_id=${process.env.KBS_COMPANY_ID || '1048'}` },
              steps: [],
            });
          }
          signal.throwIfAborted();
          await libraryFetch('PATCH', null, { key, linked_script: out.item.name, updated_by: WHOAMI }, COVERAGE_URL);
          job.result = { scriptName: out.item.name, steps: 0, recipe };
          job.state = 'done';
          aiLog(key, `Linked to "${out.item.name}" — this workflow renders from its own recipe, not from recorded steps.`);
          return;
        }
        const { runAiRecord, slotProfileDir } = await loadAiRecord();
        signal.throwIfAborted();
        const { script } = await runAiRecord(job.item, {
          onLog: (m) => aiLog(key, m), signal, profileDir: slotProfileDir(slot),
          plan: plans[key]?.plan || null, // prepared in the background when the workflow appeared
          onPlan: (p) => setPlan(key, p, job.item?.title), // keep revisions / consult answers for next time
        });
        // Cancel may have landed during the final turn — never publish a run the user stopped.
        signal.throwIfAborted();
        // Narration: the recorder leaves steps un-narrated (the agent's per-turn reasoning is kept
        // in step.aiReason for debugging only). Write real, codebase-grounded narration with the same
        // writer "Draft with AI" uses, so AI-recorded scripts read like the hand-recorded ones.
        aiLog(key, 'Writing narration…');
        try {
          let lines = null;
          try {
            lines = JSON.parse((await runClaude(buildPrompt(script.steps, script.name), buildPromptPlain(script.steps, script.name))).match(/\[[\s\S]*\]/)?.[0] || '[]');
          } catch (claudeErr) {
            aiLog(key, `  (Claude narration failed, falling back to gemini-3.8-flash…)`);
            lines = await runGemini(script.steps, script.name);
          }
          if (Array.isArray(lines)) {
            lines = sanitizeNarrationLines(lines);
            script.steps.forEach((s, i) => { const l = String(lines[i] || '').trim(); if (l) s.narration = l; });
          }
        } catch (e) {
          aiLog(key, `  (narration skipped — ${String(e?.message || e).slice(0, 100)}; use ✨ Draft with AI in the editor)`);
        }
        signal.throwIfAborted();
        // Never silently overwrite a script someone recorded by hand under the same name.
        const desired = safeName(script.name);
        if (await libraryGetByName(desired)) {
          script.name = `${desired}-ai`;
          aiLog(key, `A script named "${desired}" already exists — saving as "${script.name}" instead.`);
        }
        const out = await saveScript(script);
        await libraryFetch('PATCH', null, { key, linked_script: out.item.name, updated_by: WHOAMI }, COVERAGE_URL);
        job.result = { scriptName: out.item.name, steps: script.steps.length };
        job.state = 'done';
        aiLog(key, `Saved as "${out.item.name}" and linked to this workflow.`);
      } catch (e) {
        job.error = signal.aborted ? 'cancelled' : withAuthHint(e?.message || e);
        job.state = 'failed';
        aiLog(key, signal.aborted ? 'Cancelled — nothing was saved.' : `✗ ${job.error}`);
      } finally {
        job.finishedAt = new Date().toISOString();
        job.item = null; job.controller = null; // don't keep the item / abort closure alive
        aiActive--;
        aiSlots.push(slot);
        pumpAiQueue();
      }
    })();
  }
}

async function libraryFetch(method, query, body, customUrl) {
  if (!LIBRARY_SECRET) throw new Error('Shared library is not configured on this machine: add STUDIO_SHARED_SECRET to ' + path.join(REPO_ROOT, '.env') + ' (ask Stephen for it), then restart the bridge (./setup.sh).');
  const base = customUrl || LIBRARY_URL;
  const url = base + (query ? '?' + new URLSearchParams(query).toString() : '');
  const r = await fetch(url, { method, headers: { Authorization: 'Bearer ' + LIBRARY_SECRET, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 300) }; }
  if (!r.ok) throw new Error(json.error || `library returned HTTP ${r.status}`);
  return json;
}
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''; req.on('data', (c) => (body += c));
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(new Error('invalid JSON body')); } });
  });
}
function sendJson(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

function runClaudeCli(prompt) {
  return new Promise((resolve, reject) => {
    // The hadrius-codebase MCP server (added by setup.sh via `claude mcp add`) lets the model
    // ground narration in real code instead of guessing — read-only tools only, nothing that
    // writes or queries live customer data.
    const allowedTools = [
      'mcp__hadrius-codebase__search_code',
      'mcp__hadrius-codebase__read_file',
      'mcp__hadrius-codebase__file_tree',
      'mcp__hadrius-codebase__list_directory',
      'mcp__hadrius-codebase__list_repos',
      'mcp__hadrius-codebase__get_framework',
      'mcp__hadrius-codebase__get_policy',
      'mcp__hadrius-codebase__search_by_tag',
    ].join(',');
    const args = ['-p', prompt, '--output-format', 'json', '--max-turns', '40', '--allowedTools', allowedTools];
    const child = execFile('claude', args, { maxBuffer: 1024 * 1024 * 20, timeout: 300000, env: claudeEnv() }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(stderr || err.message));
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.is_error || (parsed.subtype && parsed.subtype !== 'success')) {
          if (parsed.result) {
            try {
              extractJson(parsed.result);
              return resolve(parsed.result);
            } catch (_) {}
          }
          return reject(new Error(`claude: ${parsed.result || parsed.subtype || stderr || 'unknown error'}`));
        }
        resolve(parsed.result ?? stdout);
      } catch (_) {
        resolve(stdout.trim());
      }
    });
    child.stdin?.end();
  });
}

async function runGeminiPrompt(prompt) {
  const key = GEMINI_API_KEY || (process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw new Error('GEMINI_API_KEY is not set (add it to ~/.hermes/.env or .env)');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${key}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || `Gemini API returned HTTP ${resp.status}`);
  const parts = data.candidates?.[0]?.content?.parts || [];
  const nonThought = parts.filter(p => p.text && !p.thought);
  const text = (nonThought.length ? nonThought : parts).map(p => p.text).filter(Boolean).join('\n').trim();
  if (!text) {
    console.error('[runGeminiPrompt] Empty response from Gemini. Response structure:', JSON.stringify(data));
    throw new Error('Gemini could not generate a response for this prompt.');
  }
  return text;
}

// `geminiPrompt` (defaults to `prompt`) is what actually gets sent if Claude fails. Several
// callers write a prompt that tells Claude "you have access to the codebase via search_code /
// read_file / ..." for MCP grounding — reused verbatim for the Gemini fallback, that tool-shaped
// language made Gemini attempt a real function call with no tools declared for the request, which
// comes back as finishReason: MALFORMED_FUNCTION_CALL and empty text. Every such caller has (or
// should have) a tool-free "Plain" twin of its prompt to pass here instead.
async function runClaude(prompt, geminiPrompt = prompt) {
  try {
    return await runClaudeCli(prompt);
  } catch (claudeErr) {
    console.warn(`Claude CLI failed (${claudeErr.message}), falling back to gemini-3.8-flash...`);
    return await runGeminiPrompt(geminiPrompt);
  }
}

const GEMINI_MCP_TOOLS = [
  {
    functionDeclarations: [
      {
        name: 'search_code',
        description: 'Search the Hadrius frontend codebase (apps/hadrius-app/src/) for page components, route definitions, button labels, modal dialogs, or form inputs.',
        parameters: {
          type: 'OBJECT',
          properties: {
            query: {
              type: 'STRING',
              description: 'Exact text or regex to search for in code (e.g. "Add policy", "datasets", "Create branch")'
            }
          },
          required: ['query']
        }
      },
      {
        name: 'read_file',
        description: 'Read the contents of a specific source file under apps/hadrius-app/src/.',
        parameters: {
          type: 'OBJECT',
          properties: {
            file_path: {
              type: 'STRING',
              description: 'Relative path to file, e.g. apps/hadrius-app/src/pages/coreloop/firm_oversight_v2/policies/add_policy_dialog.tsx'
            }
          },
          required: ['file_path']
        }
      },
      {
        name: 'list_directory',
        description: 'List the files and subdirectories under a path in apps/hadrius-app/src/.',
        parameters: {
          type: 'OBJECT',
          properties: {
            path: {
              type: 'STRING',
              description: 'Directory path to list, e.g. apps/hadrius-app/src/pages/coreloop/firm_oversight_v2'
            }
          },
          required: ['path']
        }
      }
    ]
  }
];

async function executeMcpTool(toolName, args) {
  const mcpName = `mcp__hadrius-codebase__${toolName}`;
  const prompt = `Call ${mcpName} with arguments: ${JSON.stringify(args)}. Output only the result.`;
  const cliArgs = ['-p', prompt, '--allowedTools', mcpName, '--max-turns', '3'];
  return new Promise((resolve) => {
    const child = execFile('claude', cliArgs, { maxBuffer: 1024 * 1024 * 10, timeout: 35000, env: claudeEnv() }, (err, stdout) => {
      if (err || !stdout) return resolve({ error: err?.message || 'Tool execution failed' });
      resolve({ result: stdout.trim().slice(0, 4000) });
    });
    child.stdin?.end();
  });
}

async function runGeminiWithTools(prompt, { maxTurns = 8 } = {}) {
  const key = GEMINI_API_KEY || (process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${key}`;

  const contents = [
    {
      role: 'user',
      parts: [{ text: prompt }]
    }
  ];

  for (let turn = 0; turn < maxTurns; turn++) {
    const payload = {
      contents,
      tools: GEMINI_MCP_TOOLS
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.error?.message || `Gemini API returned HTTP ${resp.status}`);
    }

    const candidate = data.candidates?.[0];
    if (!candidate?.content) {
      throw new Error('Gemini returned an empty candidate');
    }

    const modelContent = candidate.content;
    contents.push(modelContent);

    const functionCalls = (modelContent.parts || []).filter(p => p.functionCall);
    if (!functionCalls.length) {
      const nonThought = (modelContent.parts || []).filter(p => p.text && !p.thought);
      const finalText = (nonThought.length ? nonThought : modelContent.parts).map(p => p.text).filter(Boolean).join('\n').trim();
      return finalText;
    }

    const responseParts = [];
    for (const fcPart of functionCalls) {
      const { name, args } = fcPart.functionCall;
      console.log(`[Gemini Tool Call] ${name}(${JSON.stringify(args)})`);
      let resultObj;
      try {
        resultObj = await executeMcpTool(name, args || {});
      } catch (err) {
        resultObj = { error: String(err?.message || err) };
      }
      responseParts.push({
        functionResponse: {
          name,
          response: resultObj
        }
      });
    }

    contents.push({
      role: 'user',
      parts: responseParts
    });
  }

  throw new Error('Gemini tool calling exceeded maximum turns');
}

async function generatePlanFromIdea({ userPrompt, previousPlan, clarification }) {
  let prompt = `You are an expert technical lead and product educator on the Hadrius compliance web app (repo "hadrius_frontend", app code under apps/hadrius-app/src/).
The user has an idea for a video walkthrough: "${userPrompt}".
Your job is to inspect the real codebase using the hadrius-codebase MCP tools (search_code, read_file, list_directory, file_tree) and produce a strictly grounded, step-by-step walkthrough plan.
Routing is two-layer: apps/hadrius-app/pages/** are thin route files; the real UI lives under apps/hadrius-app/src/pages/coreloop/** (module display names do not match folder names — search for labels and route strings rather than guessing folders).

${GROUNDING_CONTRACT}

IMPORTANT RULES:
1. Read everything the plan touches before writing it: the page behind the start route and every dialog/drawer/menu/wizard component a step uses. Then output the final JSON.
2. Determine which of the 6 Hadrius modules this workflow belongs to:
   - "Testing program"
   - "People oversight"
   - "Branches"
   - "Communications"
   - "Marketing"
   - "Account surveillance"
   (or "Other" if genuinely none of these).
3. Step 1 MUST ALWAYS be the starting navigation step: "Navigate to <Module> > <Tab>".
4. Followed by 3 to 10 clear, imperative steps. Each step must reference exact visible UI labels in quotes, e.g. Click "Add policy", Enter policy name in "Policy title", Click "Save".
5. Also determine "prerequisites": what must already exist in the app (a record in a specific status, a permission, a feature flag, a second entity) before these steps are actually possible — a fresh/typical company might not have it by default. Skip file uploads (already handled automatically by the recorder). List each as a short plain-English line; empty array if nothing special is required. Set "provisionable" to one of "none-needed", "likely-already-present", "self-serve-quick", "needs-deliberate-setup", or "structurally-blocked" (cannot be created through the UI at all here) — if "structurally-blocked", also set "blockerReason" to the specific, cited reason.
6. Return ONLY a valid JSON object (no markdown fence, no surrounding prose) in this exact shape:
{
  "title": "Clean, human-readable walkthrough title (e.g. How to add a new policy)",
  "module": "Testing program",
  "startRoute": "/testing-program/policies",
  "summary": "One sentence summary of the workflow.",
  "steps": [
    "Navigate to Testing program > Policies",
    "Click \\"Add policy\\" to open the dialog.",
    ...
  ],
  "sources": ["apps/hadrius-app/src/..."],
  "prerequisites": ["short line each: role, data or setting required"],
  "provisionable": "none-needed",
  "blockerReason": "",
  "step_grounding": [
    { "step": 1, "file": "apps/hadrius-app/src/components/.../nav config file", "quote": "the label as it appears in code", "verified": true },
    { "step": 2, "file": "apps/hadrius-app/src/pages/coreloop/.../dialog.tsx", "quote": "<Button>Add policy</Button>", "verified": true }
  ],
  "confidence": "high"
}
"step_grounding" MUST have exactly one entry per step, in order. Set "verified": false with a "reason" for any step you could not confirm in the source.
`;

  if (previousPlan) {
    prompt += `\n\nPREVIOUS PROPOSED PLAN:\n${JSON.stringify(previousPlan, null, 2)}`;
  }
  if (clarification) {
    prompt += `\n\nUSER'S CLARIFICATION & REQUESTED CHANGES:\n"${clarification}"\nAdjust the plan according to their feedback and the codebase.`;
  }

  let rawOutput;
  try {
    rawOutput = await runClaudeCli(prompt);
  } catch (claudeErr) {
    console.warn(`Claude CLI with MCP failed (${claudeErr.message}), falling back to Gemini with custom MCP tool calling...`);
    try {
      rawOutput = await runGeminiWithTools(prompt);
    } catch (toolErr) {
      console.warn(`Gemini with tools failed (${toolErr.message}), falling back to Gemini direct prompt...`);
      const fallbackPrompt = `You are an expert product educator on the Hadrius compliance web app.
The user wants a video walkthrough plan for: "${userPrompt}".
${previousPlan ? `Previous plan: ${JSON.stringify(previousPlan)}` : ''}
${clarification ? `User feedback/clarification: "${clarification}"` : ''}

Hadrius has 6 core modules:
1. Testing program (policies, tests, exceptions, calendar, risks & controls) - route prefix /testing-program/
2. People oversight (employees, attestations, disclosures, certifications) - route prefix /people-oversight/
3. Branches (branch directory, inspections, exams) - route prefix /branches/
4. Communications (email review, instant messages, lexicon, datasets, cases) - route prefix /communications/
5. Marketing (materials review, websites, social media) - route prefix /marketing/
6. Account surveillance (trades, holdings, accounts, flags) - route prefix /account-surveillance/

Formulate a clean, grounded step-by-step walkthrough plan for what the user wants to achieve.
Step 1 MUST ALWAYS be the starting navigation step: "Navigate to <Module> > <Tab>".
Followed by 3 to 10 clear, imperative steps referencing visible buttons/dialogs in quotes.

Return ONLY a valid JSON object in this exact shape:
{
  "title": "Clean concise walkthrough title",
  "module": "Communications",
  "startRoute": "/communications/cases",
  "summary": "One sentence summary of the workflow.",
  "steps": [
    "Navigate to Communications > Cases",
    ...
  ]
}`;
      rawOutput = await runGeminiPrompt(fallbackPrompt);
    }
  }

  const plan = extractJson(String(rawOutput));
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) {
    throw new Error('AI could not generate a valid step-by-step plan for this idea. Please try clarifying your request.');
  }
  // Verification record computed from the per-step proof, not the model's headline claim. A plan
  // written by the no-tools Gemini fallback has no proof at all and correctly comes out "low".
  plan.grounding = assessGrounding(plan);
  delete plan.step_grounding;
  delete plan.confidence;

  // Ensure Step 1 has navigation
  const first = plan.steps[0] || '';
  const hasNav = /^(navigate to|open|go to)\s+/i.test(first);
  if (!hasNav && plan.startRoute) {
    const tab = plan.startRoute.split('/').filter(Boolean).pop()?.replace(/[-_]/g, ' ') || 'Overview';
    const tabLabel = tab.charAt(0).toUpperCase() + tab.slice(1);
    plan.steps.unshift(`Navigate to ${plan.module || 'Workflow'} > ${tabLabel}`);
  }

  return plan;
}

/** Shared plan context block both step-editing prompts below prefix onto their own instructions. */
function planContextBlock({ module, workflow, steps, markIndex }) {
  const lines = (steps || []).map((s, i) => `${i + 1}${i === markIndex ? '  <-- INSERT HERE' : ''}. ${typeof s === 'string' ? s : (s.instruction || '')}`);
  return `WORKFLOW: ${workflow?.title || '(untitled)'}
Module: ${module || workflow?.module || '(unknown)'}
Start route: ${workflow?.startRoute || workflow?.start_route || '(unknown)'}
Summary: ${workflow?.summary || workflow?.purpose || '(none given)'}

FULL PLAN FOR CONTEXT (do not rewrite these — you are only producing the ONE step described below):
${lines.join('\n') || '(no steps yet)'}`;
}

/**
 * "Ground in codebase" for a brand-new step a person is inserting by hand. Takes their rough idea
 * of what the step should do and turns it into the same precise, source-verified instruction style
 * as the rest of the plan — exact visible button/field text in quotes — so it doesn't leave
 * Auto-record stuck guessing at a label that doesn't exist on the page.
 */
async function groundNewStepFromCodebase({ module, workflow, steps, insertAt, rawIdea }) {
  const prompt = `You are grounding ONE new step being inserted into an existing, source-verified walkthrough plan for the Hadrius compliance web app (repo "hadrius_frontend", app code under apps/hadrius-app/src/). Use ONLY the hadrius-codebase MCP tools (search_code, read_file, list_directory, file_tree) — read the real component behind the surrounding steps' page/dialog before answering.

${planContextBlock({ module, workflow, steps, markIndex: insertAt })}

THE PERSON'S ROUGH IDEA FOR THE NEW STEP (rewrite this, don't just repeat it):
"${rawIdea}"

Find the exact page/dialog/component this step happens in (inferred from the surrounding steps above) and rewrite the idea into ONE precise, imperative instruction sentence in the same style as the plan — reference the EXACT visible button/field/tab label in quotes, e.g. Click "Archive policy", Enter the date in "Due date". If you cannot confirm a matching control in the source, say so honestly rather than inventing a label.

Return ONLY a JSON object, no markdown fence, no other text:
{"instruction": "the rewritten step", "verified": true|false, "file": "apps/... or empty if not verified", "quote": "the exact code snippet proving the label, or empty", "reason": "only when verified is false — what you could not confirm"}`;

  let raw;
  try { raw = await runClaudeCli(prompt); }
  catch (claudeErr) {
    console.warn(`Claude CLI with MCP failed for step grounding (${claudeErr.message}), falling back to Gemini with tools...`);
    try { raw = await runGeminiWithTools(prompt); }
    catch (toolErr) {
      console.warn(`Gemini with tools failed for step grounding (${toolErr.message}), falling back to Gemini direct prompt (ungrounded)...`);
      raw = await runGeminiPrompt(`${prompt}\n\n(No codebase tools are available to you right now — do your best from the workflow context alone, and set "verified": false.)`);
    }
  }
  const out = extractJson(String(raw));
  if (!out?.instruction) throw new Error('AI did not return a usable step');
  return { instruction: String(out.instruction).trim(), verified: out.verified === true, file: out.file || null, quote: out.quote || null, reason: out.reason || null };
}

/**
 * Per-step "Edit with AI" — re-grounds or rewrites ONE existing step, either against a free-text
 * ask from the person, or (no instruction given) just re-verifies its labels against the current
 * codebase, which is exactly what a step needs after the underlying UI changed out from under it.
 */
async function refineStepWithCodebase({ module, workflow, steps, stepIndex, instruction }) {
  const current = steps?.[stepIndex];
  const currentText = typeof current === 'string' ? current : (current?.instruction || '');
  if (!currentText) throw new Error('no step at that position');

  const ask = instruction?.trim()
    ? `THE PERSON'S REQUESTED CHANGE:\n"${instruction.trim()}"\nApply it, and verify the result against the source.`
    : `No specific change was requested — just RE-VERIFY this step against the current codebase and correct anything that has drifted (a renamed button, a moved control, a label that no longer exists) while keeping its intent the same.`;

  const prompt = `You are revising ONE step of an existing, source-verified walkthrough plan for the Hadrius compliance web app (repo "hadrius_frontend", app code under apps/hadrius-app/src/). Use ONLY the hadrius-codebase MCP tools (search_code, read_file, list_directory, file_tree) — read the real component behind this step before answering.

${planContextBlock({ module, workflow, steps, markIndex: stepIndex })}

THE STEP TO REVISE (step ${stepIndex + 1}):
"${currentText}"

${ask}

Return ONLY a JSON object, no markdown fence, no other text:
{"instruction": "the revised step", "verified": true|false, "file": "apps/... or empty if not verified", "quote": "the exact code snippet proving the label, or empty", "reason": "only when verified is false — what you could not confirm"}`;

  let raw;
  try { raw = await runClaudeCli(prompt); }
  catch (claudeErr) {
    console.warn(`Claude CLI with MCP failed for step refine (${claudeErr.message}), falling back to Gemini with tools...`);
    try { raw = await runGeminiWithTools(prompt); }
    catch (toolErr) {
      console.warn(`Gemini with tools failed for step refine (${toolErr.message}), falling back to Gemini direct prompt (ungrounded)...`);
      raw = await runGeminiPrompt(`${prompt}\n\n(No codebase tools are available to you right now — do your best from the workflow context alone, and set "verified": false.)`);
    }
  }
  const out = extractJson(String(raw));
  if (!out?.instruction) throw new Error('AI did not return a usable step');
  return { instruction: String(out.instruction).trim(), verified: out.verified === true, file: out.file || null, quote: out.quote || null, reason: out.reason || null };
}

/**
 * Post-process narration lines to eliminate robotic command clichés and
 * ensure natural storytelling flow with breathing room on routine transitions.
 */
function sanitizeNarrationLines(lines) {
  if (!Array.isArray(lines)) return lines;
  return lines.map((raw) => {
    let line = String(raw || '').trim();
    if (!line) return '';

    // Strip surrounding quotes if wrapped
    if ((line.startsWith('"') && line.endsWith('"')) || (line.startsWith("'") && line.endsWith("'"))) {
      line = line.slice(1, -1).trim();
    }

    // Pure mechanical command artifacts -> leave silent for breathing room
    if (/^click\s+(?:the\s+)?(?:next|continue|done|proceed|back|submit|save)(?:\s+button)?\.?$/i.test(line)) {
      return '';
    }
    if (/^click\s+(?:this|that|the)\s+button\.?$/i.test(line)) {
      return '';
    }
    if (/^type\s+(?:this|that|here)\.?$/i.test(line)) {
      return '';
    }

    // Soften "Click Next to continue to..." -> "Continue to..."
    line = line.replace(/^[Cc]lick\s+(?:the\s+)?next(?:\s+button)?\s+to\s+continue(?:\s+to)?\s*/i, 'Continue to ');

    // Soften "Click this/the button to ..." -> "Select this to ..."
    line = line.replace(/^[Cc]lick\s+(?:the|this|that)\s+button\s+to\s+/i, 'Select this to ');

    // Soften "Click the [X] button" -> "Select [X]"
    line = line.replace(/\b[Cc]lick\s+(?:on\s+)?(?:the\s+)?(.+?)\s+button\b/g, (m, btn) => `select ${btn}`);

    // Soften leading "Click on " / "Click "
    line = line.replace(/^[Cc]lick\s+on\s+/i, 'Select ');
    line = line.replace(/^[Cc]lick\s+/i, 'Select ');

    // Soften leading "Type [text] into [field]" -> "Enter [text] into [field]"
    line = line.replace(/^[Tt]ype\s+(?:in|into)?\s*/i, 'Enter ');

    // Soften "Hit [X]" -> "Select [X]"
    line = line.replace(/^[Hh]it\s+/i, 'Select ');

    // Never speak brand name Hadrius out loud in narration
    line = line.replace(/\bHadrius\b/g, 'the platform');

    if (line.length > 0) {
      line = line.charAt(0).toUpperCase() + line.slice(1);
    }
    return line;
  });
}

async function runGemini(steps, scriptName) {
  const key = GEMINI_API_KEY || (process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw new Error('GEMINI_API_KEY is not set (add it to ~/.hermes/.env or .env)');

  const lines = steps.map((s, i) => {
    const t = s.target || {};
    if (s.action === 'navigate') return `${i + 1}. [navigate] arrives on route ${s.route || s.value}`;
    if (s.action === 'press') return `${i + 1}. [press ${s.key}]`;
    if (s.action === 'type') return `${i + 1}. [type] enters "${s.value}" into ${t.label || t.placeholder || t.name || 'a field'}${t.heading ? ` (section: ${t.heading})` : ''}`;
    return `${i + 1}. [click] ${t.role || 'element'} "${t.name || t.text || ''}"${t.heading ? ` (section: ${t.heading})` : ''}${t.inDialog ? ' (in a dialog)' : ''}`;
  }).join('\n');

  const prompt = `You are writing voiceover narration for a screen-recorded product walkthrough video titled "${scriptName || 'walkthrough'}".
Below is the ordered sequence of recorded UI actions on screen:

${lines}

Write voiceover narration that flows like an engaging, natural STORY — like a knowledgeable, friendly guide walking a colleague through the workflow.

CRITICAL RULES — NEVER BE ROBOTIC:
1. STRICT BAN ON MECHANICAL COMMANDS:
   - NEVER say: "Click this button", "Click that button", "Click Next", "Click Submit", "Click on...", "Hit...", "Tap...", "Type this", "Type that", or "Enter [text] into...".
   - The viewer sees the mouse clicks and keystrokes on screen. Do NOT narrate physical movements or dictate mechanical actions.
   - Instead, explain user intent, workflow purpose, and what is being accomplished:
     * BAD: "Click this button." -> GOOD: "Let's open up the control details to make our updates."
     * BAD: "Click Next." -> GOOD: "" (silent breathing room) OR "With details in place, we can move into ownership."
     * BAD: "Type the description." -> GOOD: "Here, we'll clarify what the control actually covers."
     * BAD: "Click Save." -> GOOD: "Saving locks in the new procedures right away, keeping your records in sync."
     * BAD: "Click the status dropdown and select Active." -> GOOD: "We'll set the status to Active so the rule begins monitoring immediately."

2. COHESIVE STORYTELLING & NATURAL FLOW:
   - Weave the sequence into a smooth, connected story from start to finish:
     * Opening: Set the stage and state the goal naturally (e.g. "We'll start in the Controls list to update our procedures.").
     * Progression: Connect steps using varied narrative bridges ("With that configured, we can now...", "From here, let's...", "Next, we'll link...", "This ensures that...").
     * Variety: Vary sentence structures and rhythm. Do NOT start every line with "Now..." or "Next...".
     * Closing: Conclude with the result or impact.

3. BREATHING ROOM (SILENT MECHANICAL TRANSITIONS):
   - Routine mechanical transitions (clicking 'Next' between wizard steps, closing dialogs, dismissals, or minor tab switches) do NOT all need speaking lines.
   - For these steps, output an EMPTY string "" (no narration). A great video lets the visuals breathe rather than talking over every micro-click.

4. PLATFORM & PRIVACY CONVENTIONS:
   - Platform naming: Refer to the system as "the platform" (never say the brand name "Hadrius" out loud).
   - Genericize sample data: The recorded names, emails, dates, and test titles are SAMPLE DATA. NEVER state specific names (e.g. "John", "Acme", "2026-04-01") out loud. Always describe them generically by role ("the test owner", "the reviewer", "the employee", "this test", "the due date").

5. PACING:
   - Keep each spoken line concise (under 18 words) so it speaks naturally without rushing or overlapping.

Output ONLY a JSON array of strings, exactly one per numbered step (${steps.length} items total), no other text.
Example format:
[
  "We'll start in the Controls list, where your active compliance rules live.",
  "Selecting Edit opens this control up for changes.",
  "Here we'll update the description to reflect what the control actually covers.",
  "",
  "Saving locks in the updated procedures right away."
]`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${key}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || `Gemini API returned HTTP ${resp.status}`);
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned an empty response');
  const arr = JSON.parse(text);
  if (!Array.isArray(arr)) throw new Error('Gemini output was not a JSON array');
  return sanitizeNarrationLines(arr);
}

function buildPrompt(steps, scriptName) {
  const lines = steps.map((s, i) => {
    const t = s.target || {};
    if (s.action === 'navigate') return `${i + 1}. [navigate] arrives on route ${s.route || s.value}`;
    if (s.action === 'press') return `${i + 1}. [press ${s.key}]`;
    if (s.action === 'type') return `${i + 1}. [type] enters "${s.value}" into ${t.label || t.placeholder || t.name || 'a field'}${t.heading ? ` (section: ${t.heading})` : ''}`;
    return `${i + 1}. [click] ${t.role || 'element'} "${t.name || t.text || ''}"${t.heading ? ` (section: ${t.heading})` : ''}${t.inDialog ? ' (in a dialog)' : ''}`;
  }).join('\n');

  return `You are writing voiceover narration for a screen-recorded product walkthrough video titled "${scriptName || 'walkthrough'}".
Below is the exact, ordered sequence of recorded UI actions for the web app:

${lines}

You have access to the codebase via search_code / read_file / get_policy / list_repos (repo: hadrius_backend and others).
Before writing narration, if it would make a line more accurate or specific, search the codebase for the real logic behind
what's happening in that step (e.g. what a cadence option actually does, what a status transition triggers, what a setting controls).
Use this to ground narration in real behavior, not guesses — but don't force it into every line.

Write voiceover narration that flows like an engaging, natural STORY — like a knowledgeable, friendly guide walking a colleague through the workflow.

CRITICAL RULES — NEVER BE ROBOTIC:
1. STRICT BAN ON MECHANICAL COMMANDS:
   - NEVER say: "Click this button", "Click that button", "Click Next", "Click Submit", "Click on...", "Hit...", "Tap...", "Type this", "Type that", or "Enter [text] into the field".
   - The viewer sees the mouse clicks and keystrokes on screen. Do NOT narrate physical movements or dictate mechanical actions.
   - Instead, explain user intent, workflow purpose, and what is being accomplished:
     * BAD: "Click this button." -> GOOD: "Let's open up the control details to make our updates."
     * BAD: "Click Next." -> GOOD: "" (silent breathing room) OR "With details in place, we can move into ownership."
     * BAD: "Type the description." -> GOOD: "Here, we'll clarify what the control actually covers."
     * BAD: "Click Save." -> GOOD: "Saving locks in the new procedures right away, keeping your records in sync."
     * BAD: "Click the status dropdown and select Active." -> GOOD: "We'll set the status to Active so the rule begins monitoring immediately."

2. COHESIVE STORYTELLING & NATURAL FLOW:
   - Weave the sequence into a smooth, connected story from start to finish:
     * Opening: Set the stage and state the goal naturally (e.g. "We'll start in the Controls list to update our procedures.").
     * Progression: Connect steps using varied narrative bridges ("With that configured, we can now...", "From here, let's...", "Next, we'll link...", "This ensures that...").
     * Variety: Vary sentence structures and rhythm. Do NOT start every line with "Now..." or "Next...".
     * Closing: Conclude with the result or impact.

3. BREATHING ROOM (SILENT MECHANICAL TRANSITIONS):
   - Routine mechanical transitions (clicking 'Next' between wizard steps, closing dialogs, dismissals, or minor tab switches) do NOT all need speaking lines.
   - For these steps, output an EMPTY string "" (no narration). A great video lets the visuals breathe rather than talking over every micro-click.

4. PLATFORM & PRIVACY CONVENTIONS:
   - Platform naming: Refer to the system as "the platform" (never say the brand name "Hadrius" out loud).
   - Genericize sample data: The recorded names, emails, dates, and test titles are SAMPLE DATA. NEVER state specific names (e.g. "John", "Acme", "2026-04-01") out loud. Always describe them generically by role ("the test owner", "the reviewer", "the employee", "this test", "the due date").

5. PACING:
   - Keep each spoken line concise (under 18 words) so it speaks naturally without rushing or overlapping.

Output ONLY a JSON array of strings, exactly one per numbered step (${steps.length} items total), no other text.
Example format:
[
  "We'll start in the Controls list, where your active compliance rules live.",
  "Selecting Edit opens this control up for changes.",
  "Here we'll update the description to reflect what the control actually covers.",
  "",
  "Saving locks in the updated procedures right away."
]`;
}

// Twin of buildPrompt() with the codebase-tools paragraph removed — see runClaude()'s geminiPrompt
// param for why a Gemini call with no tools declared needs this instead of the Claude version.
function buildPromptPlain(steps, scriptName) {
  const lines = steps.map((s, i) => {
    const t = s.target || {};
    if (s.action === 'navigate') return `${i + 1}. [navigate] arrives on route ${s.route || s.value}`;
    if (s.action === 'press') return `${i + 1}. [press ${s.key}]`;
    if (s.action === 'type') return `${i + 1}. [type] enters "${s.value}" into ${t.label || t.placeholder || t.name || 'a field'}${t.heading ? ` (section: ${t.heading})` : ''}`;
    return `${i + 1}. [click] ${t.role || 'element'} "${t.name || t.text || ''}"${t.heading ? ` (section: ${t.heading})` : ''}${t.inDialog ? ' (in a dialog)' : ''}`;
  }).join('\n');

  return `You are writing voiceover narration for a screen-recorded product walkthrough video titled "${scriptName || 'walkthrough'}".
Below is the exact, ordered sequence of recorded UI actions for the web app:

${lines}

Write voiceover narration that flows like an engaging, natural STORY — like a knowledgeable, friendly guide walking a colleague through the workflow.

CRITICAL RULES — NEVER BE ROBOTIC:
1. STRICT BAN ON MECHANICAL COMMANDS:
   - NEVER say: "Click this button", "Click that button", "Click Next", "Click Submit", "Click on...", "Hit...", "Tap...", "Type this", "Type that", or "Enter [text] into the field".
   - The viewer sees the mouse clicks and keystrokes on screen. Do NOT narrate physical movements or dictate mechanical actions.
   - Instead, explain user intent, workflow purpose, and what is being accomplished:
     * BAD: "Click this button." -> GOOD: "Let's open up the control details to make our updates."
     * BAD: "Click Next." -> GOOD: "" (silent breathing room) OR "With details in place, we can move into ownership."
     * BAD: "Type the description." -> GOOD: "Here, we'll clarify what the control actually covers."
     * BAD: "Click Save." -> GOOD: "Saving locks in the new procedures right away, keeping your records in sync."
     * BAD: "Click the status dropdown and select Active." -> GOOD: "We'll set the status to Active so the rule begins monitoring immediately."

2. COHESIVE STORYTELLING & NATURAL FLOW:
   - Weave the sequence into a smooth, connected story from start to finish:
     * Opening: Set the stage and state the goal naturally (e.g. "We'll start in the Controls list to update our procedures.").
     * Progression: Connect steps using varied narrative bridges ("With that configured, we can now...", "From here, let's...", "Next, we'll link...", "This ensures that...").
     * Variety: Vary sentence structures and rhythm. Do NOT start every line with "Now..." or "Next...".
     * Closing: Conclude with the result or impact.

3. BREATHING ROOM (SILENT MECHANICAL TRANSITIONS):
   - Routine mechanical transitions (clicking 'Next' between wizard steps, closing dialogs, dismissals, or minor tab switches) do NOT all need speaking lines.
   - For these steps, output an EMPTY string "" (no narration). A great video lets the visuals breathe rather than talking over every micro-click.

4. PLATFORM & PRIVACY CONVENTIONS:
   - Platform naming: Refer to the system as "the platform" (never say the brand name "Hadrius" out loud).
   - Genericize sample data: The recorded names, emails, dates, and test titles are SAMPLE DATA. NEVER state specific names (e.g. "John", "Acme", "2026-04-01") out loud. Always describe them generically by role ("the test owner", "the reviewer", "the employee", "this test", "the due date").

5. PACING:
   - Keep each spoken line concise (under 18 words) so it speaks naturally without rushing or overlapping.

Output ONLY a JSON array of strings, exactly one per numbered step (${steps.length} items total), no other text.
Example format:
[
  "We'll start in the Controls list, where your active compliance rules live.",
  "Selecting Edit opens this control up for changes.",
  "Here we'll update the description to reflect what the control actually covers.",
  "",
  "Saving locks in the updated procedures right away."
]`;
}

// A recipe's own log() calls double as its slides' captions (see tools/stage-lib.mjs) — accurate,
// but written in an engineer's internal shorthand ("[act] recipients: searching..."), not narration.
// These two mirror buildPrompt/runGemini above but take that caption text directly instead of
// recorded steps, since a recipe caption is already a human-written phrase, not a raw DOM target.
function buildRecipePrompt(captions, scriptName) {
  const lines = captions.map((c, i) => `${i + 1}. ${c}`).join('\n');
  return `You are writing voiceover narration for a screen-recorded product walkthrough video titled "${scriptName || 'walkthrough'}".
This workflow is demonstrated by a recipe script — below is the ordered sequence of what happens on screen, described in internal engineering shorthand:

${lines}

You have access to the codebase via search_code / read_file / get_policy / list_repos (repo: hadrius_backend and others).
Before writing narration, if it would make a line more accurate or specific, search the codebase for the real logic behind
what's happening in that step (e.g. what a status transition actually triggers, what a setting controls). Use this to
ground narration in real behavior, not guesses — but don't force it into every line.

Rewrite EACH numbered line above into voiceover narration that flows like an engaging, cohesive STORY — guiding the viewer naturally through what is happening, why it matters, and how each step connects to the next.

CRITICAL RULES — NEVER BE ROBOTIC:
1. STRICT BAN ON MECHANICAL COMMANDS:
   - NEVER say: "Click this", "Click that", "Click Next", "Click Submit", "Hit...", "Type this", "Type that".
   - Viewers see the actions on screen. Describe user intent, business purpose, and workflow milestones instead of mechanical commands.
   - For pure mechanical transitions or intermediate steps (e.g. clicking 'Next' in a wizard), output an EMPTY string "" to give the video natural breathing room.
2. COHESIVE STORYTELLING & NATURAL FLOW:
   - Weave the sequence into a smooth, connected story.
   - Opening introduces the workflow goal; middle explains context; closing highlights the finished state.
   - Vary transitions and sentence structures. Do not start every sentence with "Now..." or "Next...".
3. PLATFORM & PRIVACY CONVENTIONS:
   - Refer to the system as "the platform" (never say "Hadrius").
   - Genericize sample data: never state specific employee names, firm names, dates, or specific record titles aloud.
4. PACING:
   - Keep each line under 18 words.

Output ONLY a JSON array of strings, exactly one per numbered line (${captions.length} items total), no other text.`;
}

function buildRecipePromptPlain(captions, scriptName) {
  const lines = captions.map((c, i) => `${i + 1}. ${c}`).join('\n');
  return `You are writing voiceover narration for a screen-recorded product walkthrough video titled "${scriptName || 'walkthrough'}".
Below is the ordered sequence of what happens on screen, described in an engineer's internal shorthand:

${lines}

Rewrite EACH numbered line above into voiceover narration that flows like an engaging, cohesive STORY — guiding the viewer naturally through what is happening, why it matters, and how each step connects to the next.

CRITICAL RULES — NEVER BE ROBOTIC:
1. STRICT BAN ON MECHANICAL COMMANDS:
   - NEVER say: "Click this", "Click that", "Click Next", "Click Submit", "Hit...", "Type this", "Type that".
   - Viewers see the actions on screen. Describe user intent, business purpose, and workflow milestones instead of mechanical commands.
   - For pure mechanical transitions or intermediate steps (e.g. clicking 'Next' in a wizard), output an EMPTY string "" to give the video natural breathing room.
2. COHESIVE STORYTELLING & NATURAL FLOW:
   - Weave the sequence into a smooth, connected story.
   - Opening introduces the workflow goal; middle explains context; closing highlights the finished state.
   - Vary transitions and sentence structures. Do not start every sentence with "Now..." or "Next...".
3. PLATFORM & PRIVACY CONVENTIONS:
   - Refer to the system as "the platform" (never say "Hadrius").
   - Genericize sample data: never state specific employee names, firm names, dates, or specific record titles aloud.
4. PACING:
   - Keep each line under 18 words.

Output ONLY a JSON array of strings, exactly one per numbered line (${captions.length} items total), no other text.`;
}

async function runGeminiRecipe(captions, scriptName) {
  const key = GEMINI_API_KEY || (process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw new Error('GEMINI_API_KEY is not set (add it to ~/.hermes/.env or .env)');
  const prompt = buildRecipePromptPlain(captions, scriptName);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${key}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json' } }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || `Gemini API returned HTTP ${resp.status}`);
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned an empty response');
  const arr = JSON.parse(text);
  if (!Array.isArray(arr)) throw new Error('Gemini output was not a JSON array');
  return sanitizeNarrationLines(arr);
}

// ---- Publish a finished render as a Pylon knowledge base article (best-effort, fire-and-forget
// from the render-completion handler below). Reuses each slide's already-generalized narration —
// the same text spoken in the video, already checked to never name real people/tests/certifications
// — as the source material, so the article and the video always agree.
const MAX_KB_SCREENSHOTS = 5;

function buildKbArticlePrompt(title, narratedSlides, sourceFile) {
  const lines = narratedSlides.map((s) => `${s.slide}. ${s.text}`).join('\n');
  const groundingStep = sourceFile
    ? `Before writing anything, read ${sourceFile} in the hadrius_backend/hadrius_frontend repos (whichever it's in) via read_file — that's the actual component implementing this workflow. Use it to verify every claim below against the real code: the exact button/label text, what each status value actually means, what a bulk action really applies to (one row vs. every selected row), what's optional vs. required, and what happens next. If anything in the narration below looks inconsistent with what the source file actually does, trust the source file and describe the real behavior instead — don't just restate the narration. If the file doesn't fully explain something, search_code / read_file nearby files (the same directory, or an imported hook/dialog) rather than guessing.`
    : `You have access to the Hadrius codebase via search_code / read_file / list_directory / file_tree — no specific source file is known for this workflow, so search for the component that implements it (try the workflow's own words, and its module) and read it before writing, to verify button labels, status meanings, and what a bulk action actually applies to. Don't guess if the code is there to check.`;
  return `You are writing a knowledge base article for the Hadrius compliance platform's customer help center, covering the workflow "${title}".

Below is the ordered narration from a walkthrough video of this exact workflow — each line is numbered by the slide it corresponds to in the video (numbers are not sequential 1..N; they're the video's own slide numbers, some slides have no narration and are omitted):

${lines}

${groundingStep}

Write a real knowledge base article — not a caption dump. Organize it into a short intro paragraph (what this covers and when you'd do it), then the body as either flowing paragraphs or a numbered step list (whichever reads more naturally for this workflow — not necessarily one step per narration line; group related actions together), and a brief closing note if there's a natural one (e.g. what happens next). Write it the way a real support/documentation team would, in a clear and professional tone.

Pick at most ${MAX_KB_SCREENSHOTS} of the numbered slides above that would most usefully appear as a screenshot in the article — key visual moments, not every step — and insert the placeholder [[SCREENSHOT:N]] (N = that slide's number) on its own line at the point in the article where it belongs.

Rules:
- Never state a specific person's name, employee name, company name, or the specific title of any test, certification, disclosure, template, or finding — describe them generically by role/purpose, exactly as the narration already does.
- The article body is raw HTML, not a JSON string — write it naturally. It's fine (expected, even) to quote a real button/label name like "Save Changes" using ordinary double quotes; don't avoid them or escape them, there is nothing to escape here.
- body_html must be simple HTML only: <p>, <h2>, <h3>, <ul>/<ol>/<li>, <strong>, <em>. No <script>, <style>, inline styles, classes, or a top-level <h1>/title (the title is stored separately).
- Output EXACTLY this format, no other text before or after:
SCREENSHOTS: [4, 9]
---BODY---
<p>...</p>...[[SCREENSHOT:4]]...`;
}
// Note: buildKbArticlePrompt's caller (publishRenderToPylon) talks to runClaudeCli/runGeminiKbArticle
// directly rather than through the generic runClaude() helper, and runGeminiKbArticle already builds
// its own tool-free prompt — so it doesn't need a "Plain" twin the way buildPrompt/buildRecipePrompt do.

async function findCoverageInfo(scriptName) {
  try {
    const cov = await libraryFetch('GET', null, null, COVERAGE_URL);
    const item = cov.items?.find((i) => i.linked_script === scriptName);
    return { title: item?.title || null, sourceFile: item?.source_file || null, module: item?.module || null };
  } catch { return { title: null, sourceFile: null, module: null }; }
}

async function runGeminiKbArticle(title, narratedSlides, sourceFile) {
  const key = GEMINI_API_KEY || (process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw new Error('GEMINI_API_KEY is not set (add it to ~/.hermes/.env or .env)');
  const lines = narratedSlides.map((s) => `${s.slide}. ${s.text}`).join('\n');
  const prompt = `You are writing a knowledge base article for the Hadrius compliance platform's customer help center, covering the workflow "${title}".

Below is the ordered narration from a walkthrough video of this exact workflow — each line is numbered by the slide it corresponds to in the video (numbers are not sequential 1..N; they're the video's own slide numbers, some slides have no narration and are omitted):

${lines}

Write a real knowledge base article — not a caption dump. Organize it into a short intro paragraph (what this covers and when you'd do it), then the body as either flowing paragraphs or a numbered step list (whichever reads more naturally for this workflow — not necessarily one step per narration line; group related actions together), and a brief closing note if there's a natural one (e.g. what happens next). Write it the way a real support/documentation team would, in a clear and professional tone.

Pick at most ${MAX_KB_SCREENSHOTS} of the numbered slides above that would most usefully appear as a screenshot in the article — key visual moments, not every step — and insert the placeholder [[SCREENSHOT:N]] (N = that slide's number) on its own line at the point in the article where it belongs.

Format your response in this EXACT structure (the first line must be a JSON array of the slide numbers you picked, then the delimiter ---BODY--- on its own line, then the article body in clean semantic HTML — <p>, <ul>, <ol>, <li>, <h3>, <strong>):

[1, 3, 5]
---BODY---
<p>This guide explains how to...</p>
[[SCREENSHOT:1]]
<ol>
  <li><strong>First action:</strong> Description...</li>
</ol>`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${key}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || `Gemini API HTTP ${resp.status}`);
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned an empty response');
  return text.trim();
}

function formatHumanTitle(str) {
  if (!str) return 'Walkthrough';
  let t = String(str).trim();
  if (t.includes('-') && (!t.includes(' ') || t.startsWith('How-to-') || t.startsWith('how-to-'))) {
    t = t.replace(/^How-to-/i, 'How to ').replace(/-/g, ' ');
  } else {
    t = t.replace(/^How-to-/i, 'How to ');
  }
  return t.replace(/\s+/g, ' ').trim();
}

function titleCaseFromScriptName(name) {
  return formatHumanTitle(name);
}

// Mirrors a rendered video into stephen@hadrius.com's Google Drive as an "Anyone with the link"
// viewer copy, alongside the Pylon KB article — same shape as publishRenderToPylon: upload, then
// write the link back onto the saved script (both the local mirror and the shared library) so the
// Recorded tab can show a Drive icon next to the Pylon one.
async function startDriveUpload(name, videoPath) {
  const title = formatHumanTitle(name);
  const drive = await googleDriveUploadVideo(videoPath, title);

  const scriptPath = path.join(REPO_ROOT, 'scripts', `${name}.script.json`);
  if (fs.existsSync(scriptPath)) {
    try {
      const scriptObj = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
      scriptObj.driveVideoId = drive.id;
      scriptObj.driveVideoUrl = drive.url;
      fs.writeFileSync(scriptPath, JSON.stringify(scriptObj, null, 2));
      if (LIBRARY_SECRET) {
        try { await libraryFetch('POST', null, { script: scriptObj, updated_by: WHOAMI }); }
        catch (e) { console.warn('[gdrive] Could not sync video link to shared script library:', e.message); }
      }
    } catch (e) {
      console.warn('[gdrive] Could not write video link onto the saved script:', e.message);
    }
  }
  return drive;
}

async function publishRenderToPylon(name, outDir) {
  const reportPath = path.join(outDir, 'report.json');
  const videoPath = path.join(outDir, `${name}.mp4`);
  if (!fs.existsSync(reportPath)) throw new Error('missing report.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const slides = report.slides || [];
  if (!slides.length) throw new Error('no slides to build an article from');

  const { title: coverageTitle, sourceFile: coverageSource, module: coverageModule } = await findCoverageInfo(name);
  let scriptObj = null;
  const scriptPath = path.join(REPO_ROOT, 'scripts', `${name}.script.json`);
  if (fs.existsSync(scriptPath)) {
    try { scriptObj = JSON.parse(fs.readFileSync(scriptPath, 'utf8')); } catch (_) {}
  }
  const rawTitle = scriptObj?.title || scriptObj?.name || coverageTitle || name;
  const title = formatHumanTitle(rawTitle);
  const module = scriptObj?.module || coverageModule;
  const sourceFile = scriptObj?.sourceFiles?.[0] || coverageSource;
  const narratedSlides = slides.filter((s) => (s.narration || s.caption || '').trim()).map((s) => ({ slide: s.slide, text: (s.narration || s.caption).trim() }));
  if (!narratedSlides.length) throw new Error('no narrated slides to write from');

  const prompt = buildKbArticlePrompt(title, narratedSlides, sourceFile);
  let result;
  try {
    result = await runClaudeCli(prompt);
  } catch (claudeErr) {
    console.warn(`Claude CLI failed for KB article drafting (${claudeErr.message}), falling back to gemini-3.8-flash...`);
    result = await runGeminiKbArticle(title, narratedSlides, sourceFile);
  }
  // A delimiter split, not JSON.parse — asking the model to hand-write body_html as an escaped JSON
  // string value was fragile in practice: an ordinary quote inside the HTML (quoting a real button
  // label, which the prompt explicitly invites) is exactly the kind of thing models occasionally
  // fail to escape correctly, and one bad quote breaks the whole response. Raw HTML after a plain
  // text marker has nothing to escape at all.
  // Tolerate the model dressing the marker up (bolding it, extra dashes/spaces, a code fence
  // around it) before giving up — a strict indexOf() on the exact literal was failing runs where
  // Claude's output was otherwise perfectly usable, just not byte-for-byte "---BODY---".
  const markerMatch = result.match(/\**-{2,}\s*BODY\s*-{2,}\**/i);
  if (!markerMatch) {
    console.warn(`[pylon] "${name}" — model output missing the ---BODY--- marker. Raw output (first 2000 chars):\n${result.slice(0, 2000)}`);
    throw new Error('model output missing the ---BODY--- marker');
  }
  const markerAt = markerMatch.index;
  const screenshotsLine = result.slice(0, markerAt);
  let bodyHtml = result.slice(markerAt + markerMatch[0].length).trim();
  bodyHtml = bodyHtml.replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (!bodyHtml) throw new Error('model returned an empty article body');
  const screenshotsMatch = screenshotsLine.match(/\[[\d,\s]*\]/);
  let rawScreenshots = [];
  try { rawScreenshots = screenshotsMatch ? JSON.parse(screenshotsMatch[0]) : []; } catch { rawScreenshots = []; }
  const screenshotSlides = [...new Set(rawScreenshots.filter((n) => slides.some((s) => s.slide === n)))].slice(0, MAX_KB_SCREENSHOTS);
  for (const n of screenshotSlides) {
    const slide = slides.find((s) => s.slide === n);
    // assemble.py writes annotated/<file> (highlight + pointer burned in) for every slide with a
    // target; fall back to the bare capture for slides that had nothing to point at.
    const annotatedPath = path.join(outDir, 'annotated', slide.file);
    const slidePath = fs.existsSync(annotatedPath) ? annotatedPath : path.join(outDir, 'slides', slide.file);
    const placeholder = `[[SCREENSHOT:${n}]]`;
    if (!bodyHtml.includes(placeholder)) continue;
    try {
      const att = await pylonUploadAttachment(slidePath, `${title} — step ${n}`);
      bodyHtml = bodyHtml.replaceAll(placeholder, `<img src="${att.url}" alt="${title} — screenshot">`);
    } catch (e) {
      console.warn(`  screenshot upload failed for slide ${n}: ${e.message} — dropping placeholder`);
      bodyHtml = bodyHtml.replaceAll(placeholder, '');
    }
  }
  bodyHtml = bodyHtml.replace(/\[\[SCREENSHOT:\d+\]\]/g, ''); // any the model referenced but we didn't upload

  // Pylon's article editor parses body_html into its own rich-text node model, which — confirmed
  // live — has no node type for <video>, <iframe>, or a bare top-level <a> hyperlink: all three get
  // silently unwrapped/stripped within seconds of creation (an automatic normalization pass, not
  // something triggered by a human opening the draft). A <figure><img>...<figcaption><a>...</a>
  // does survive intact, though — Pylon's own "captioned image" node apparently allows a link inside
  // the caption specifically. That gives a poster image with a clickable "watch the video" caption
  // right under it, the closest thing to an embed this API actually supports.
  if (fs.existsSync(videoPath)) {
    try {
      const videoAtt = await pylonUploadAttachment(videoPath, title);
      const posterSlide = slides[0];
      let videoHtml = `<p><strong>Video walkthrough:</strong> ${videoAtt.url}</p>\n`; // fallback if the poster upload fails
      try {
        const posterAtt = await pylonUploadAttachment(path.join(outDir, 'slides', posterSlide.file), `${title} — video`);
        videoHtml = `<figure><img src="${posterAtt.url}" alt="Video walkthrough"><figcaption><a href="${videoAtt.url}">▶ Watch the video walkthrough</a></figcaption></figure>\n`;
      } catch (e) {
        console.warn(`  video poster upload failed: ${e.message} — url text only`);
      }
      bodyHtml = `${videoHtml}${bodyHtml}`;
    } catch (e) {
      console.warn(`  video upload failed: ${e.message} — publishing article without video`);
    }
  }

  const article = await pylonCreateArticle({ title, bodyHtml, collectionId: pylonCollectionForModule(module) });

  const targetModule = canonicalModule(module) || module || 'Testing program';

  // 0. Link the saved script to the article it was published from, both directions: the script
  // gets the article id/url (so a re-render knows an article already exists for it), and
  // /pylon/articles reads this same field back to offer a "Load script" button per article.
  if (scriptObj) {
    scriptObj.pylonArticleId = article.id;
    scriptObj.pylonArticleUrl = pylonArticleUrl(article);
    try { fs.writeFileSync(scriptPath, JSON.stringify(scriptObj, null, 2)); } catch (_) {}
    if (LIBRARY_SECRET) {
      try { await libraryFetch('POST', null, { script: scriptObj, updated_by: WHOAMI }); }
      catch (e) { console.warn('[pylon] Could not sync article link to shared script library:', e.message); }
    }
  }

  // 1. Record in local manual links
  try {
    const links = new Set(readManualLinks());
    links.add(title);
    writeManualLinks([...links]);
    invalidateCoverageCache();
  } catch (_) {}

  // 2. Sync to shared team repository (Neon)
  if (LIBRARY_SECRET && targetModule && title) {
    try {
      const candKey = candSlug(`${targetModule}-${title}`);
      // Ensure candidate exists in Neon table
      await libraryFetch('POST', null, {
        candidates: [{
          key: candKey,
          module: targetModule,
          title: title,
          description: `Walkthrough video: ${name}`,
          start_route: scriptObj?.environment?.startUrl || scriptObj?.steps?.[0]?.route || '/overview',
          source_file: scriptObj?.steps?.[0]?.sources?.[0] || null,
          priority: 'medium',
          updated_by: WHOAMI
        }],
        full_scan: false
      }, COVERAGE_URL);

      // Mark candidate as linked to this walkthrough script
      await libraryFetch('PATCH', null, {
        key: candKey,
        linked_script: name,
        updated_by: WHOAMI
      }, COVERAGE_URL);
    } catch (e) {
      console.warn('[pylon] Could not sync link to shared repository:', e.message);
    }
  }

  // 3. Update local workflows.json
  try {
    if (fs.existsSync(WORKFLOWS_FILE)) {
      const data = JSON.parse(fs.readFileSync(WORKFLOWS_FILE, 'utf8'));
      if (Array.isArray(data.modules)) {
        let modObj = data.modules.find(m => m.module.toLowerCase() === targetModule.toLowerCase());
        if (!modObj) {
          modObj = { module: targetModule, workflows: [] };
          data.modules.push(modObj);
        }
        let wf = (modObj.workflows || []).find(w => w.title.toLowerCase() === title.toLowerCase());
        if (wf) {
          wf.linkedScript = name;
          wf.status = 'covered';
        } else {
          modObj.workflows.unshift({
            title,
            purpose: `Walkthrough video: ${name}`,
            startRoute: scriptObj?.environment?.startUrl || scriptObj?.steps?.[0]?.route || '/overview',
            priority: 'medium',
            steps: (scriptObj?.steps || []).map(s => s.instruction || s.caption || s.narration || '').filter(Boolean),
            sources: [],
            linkedScript: name,
            status: 'covered'
          });
        }
        fs.writeFileSync(WORKFLOWS_FILE, JSON.stringify(data, null, 2));
      }
    }
  } catch (_) {}

  return article;
}

function buildAutoHealPrompt(step, candidates, route) {
  const t = step.target || {};
  return `You are an automated code-aware debugger repairing a broken browser walkthrough step that failed due to UI drift or code changes in the Hadrius web app.

BROKEN STEP:
- Action: ${step.action}
- Route: ${route || step.route || 'unknown'}
- Narration / User Intent: "${step.narration || ''}"
- Caption: "${step.caption || ''}"
- Original Target Fingerprint:
${JSON.stringify(t, null, 2)}

LIVE CANDIDATE ELEMENTS EXTRACTED FROM THE PAGE:
${JSON.stringify(candidates, null, 2)}

INSTRUCTIONS:
1. USE MCP TOOLS (mcp__hadrius-codebase__search_code, mcp__hadrius-codebase__read_file) to search the Hadrius frontend codebase (e.g. apps/hadrius-app/src/) for this route, component, or the previous button text "${t.text || t.name || ''}".
2. Inspect the component code or recent git changes to see how this button/control was renamed, what new data-testid, aria-label, or icon button replaces it, or if it was moved into a dropdown/actions menu.
3. Match the code findings against the LIVE CANDIDATE ELEMENTS list above.
4. Output ONLY a JSON object in this exact format (no markdown fences, no extra text):
{
  "candidateId": <integer matching candidateId from the candidates list, or null if not found>,
  "confidence": <number between 0.0 and 1.0>,
  "codeEvidence": "<1-2 sentences citing exact file/component code found via MCP>",
  "explanation": "<short plain English sentence explaining why this candidate replaces the broken step>"
}`;
}

async function runGeminiAutoHeal(step, candidates, route) {
  const key = GEMINI_API_KEY || (process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw new Error('GEMINI_API_KEY is not set');

  const t = step.target || {};
  const prompt = `You are an automated debugger repairing a broken browser walkthrough step that failed due to UI drift or button renaming in Hadrius.

BROKEN STEP:
- Action: ${step.action}
- Route: ${route || step.route || ''}
- Narration Intent: "${step.narration || ''}"
- Original Target: ${JSON.stringify(t)}

CANDIDATE INTERACTIVE ELEMENTS CURRENTLY ON THE LIVE PAGE:
${JSON.stringify(candidates, null, 2)}

Evaluate the candidate elements against the intended action and narration. Select the best matching candidateId.
Output ONLY a JSON object in this format:
{
  "candidateId": <integer candidateId from list, or null>,
  "confidence": <number 0.0 to 1.0>,
  "codeEvidence": "Semantic matching of element label, role, heading, and narration intent",
  "explanation": "<short explanation of why this element is the replacement>"
}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${key}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || `Gemini HTTP ${resp.status}`);
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response from Gemini');
  return JSON.parse(text);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const u = new URL(req.url, 'http://x');
  loadDotEnv();

  // ---- record-time capture ("Staged Studio" Phase 0): one slide per step, written as the person
  // clicks through, keyed by the step's captureId (stable across later edits/reordering) rather
  // than its list index. renderer/from-recording.mjs assembles a video straight from these — the
  // first render for a script never touches staging.
  const captureMatch = req.method === 'POST' && u.pathname.match(/^\/capture\/([^/]+)\/slide$/);
  if (captureMatch) {
    try {
      const recordingId = captureMatch[1].replace(/[^\w-]+/g, '');
      const body = await readJsonBody(req);
      const captureId = String(body.captureId || '').replace(/[^\w-]+/g, '');
      const m = /^data:image\/png;base64,(.+)$/.exec(body.dataUrl || '');
      if (!recordingId || !captureId || !m) throw new Error('missing recordingId, captureId, or a data:image/png;base64,... dataUrl');
      const dir = path.join(REPO_ROOT, 'out', '_recordings', recordingId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `step_${captureId}.png`), Buffer.from(m[1], 'base64'));
      return sendJson(res, 200, { ok: true });
    } catch (e) { return sendJson(res, 400, { ok: false, error: String(e?.message || e) }); }
  }

  const getCaptureMatch = req.method === 'GET' && u.pathname.match(/^\/capture\/([^/]+)\/slide\/([^/]+)$/);
  if (getCaptureMatch) {
    const recordingId = getCaptureMatch[1].replace(/[^\w-]+/g, '');
    const filename = path.basename(getCaptureMatch[2]);
    const filePath = path.join(REPO_ROOT, 'out', '_recordings', recordingId, filename);
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
      return fs.createReadStream(filePath).pipe(res);
    }
    return sendJson(res, 404, { ok: false, error: 'slide not found' });
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      product: 'hadrius-studio-beta',
      version: LOCAL_VERSION,
      library: !!LIBRARY_SECRET,
      geminiFallback: !!(GEMINI_API_KEY || process.env.GEMINI_API_KEY),
      user: WHOAMI,
      loggedIn: fs.existsSync(PROFILE_DIR),
    }));
  }

  // ---- status of the two things every AI feature depends on, for the panel's header indicators ----
  if (req.method === 'GET' && u.pathname === '/status/tools') {
    const fresh = u.searchParams.get('fresh') === '1';
    const [claude, codebase, drive] = await Promise.all([
      checkClaudeAuth({ maxAgeMs: fresh ? 0 : 60000 }),
      checkCodebaseMcp({ maxAgeMs: fresh ? 0 : 60000 }),
      checkGoogleDrive({ maxAgeMs: fresh ? 0 : 60000 }),
    ]);
    return sendJson(res, 200, {
      ok: true,
      claude: { connected: claude.loggedIn === true, detail: claude.detail, fixCommand: 'claude login' },
      codebase: { connected: codebase.connected === true, detail: codebase.detail, fixCommand: 'claude mcp login hadrius-codebase' },
      drive: { connected: drive.connected === true, detail: drive.detail, fixCommand: null },
    });
  }

  // ---- app version + whether this install is behind origin/main, for the header's version line ----
  if (req.method === 'GET' && u.pathname === '/version') {
    const fresh = u.searchParams.get('fresh') === '1';
    const update = await checkForUpdate({ maxAgeMs: fresh ? 0 : 5 * 60000 });
    return sendJson(res, 200, {
      ok: true,
      version: LOCAL_VERSION,
      upToDate: update.upToDate,
      latestVersion: update.latestVersion,
      commitsBehind: update.commitsBehind,
      checkError: update.detail,
    });
  }

  // ---- Studio Lite: source-grounded workflows and live Pylon collection contents ----
  if (u.pathname === '/workflows') {
    if (req.method === 'GET') {
      try {
        let localData = { modules: [] };
        if (fs.existsSync(WORKFLOWS_FILE)) {
          try { localData = JSON.parse(fs.readFileSync(WORKFLOWS_FILE, 'utf8')); } catch (_) {}
        }
        const manualLinksSet = new Set(readManualLinks());
        const dismissedSet = new Set(readDismissedWorkflows());

        if (LIBRARY_SECRET) {
          try {
            const sharedCov = await getCachedCoverage({ fresh: u.searchParams.get('fresh') === '1' });
            if (sharedCov && Array.isArray(sharedCov.items)) {
              for (const it of sharedCov.items) {
                if (it.dismissed || it.status === 'dismissed') {
                  dismissedSet.add(it.title);
                }
                if (it.linked_script || it.status === 'covered') {
                  manualLinksSet.add(it.title);
                }
              }

              const localWorkflowMap = new Map();
              for (const mod of localData.modules || []) {
                for (const wf of mod.workflows || []) {
                  localWorkflowMap.set(`${mod.module.toLowerCase()}::${wf.title.toLowerCase()}`, wf);
                }
              }

              const sharedByModule = new Map();
              for (const it of sharedCov.items) {
                const canon = canonicalModule(it.module);
                if (!canon) continue;
                if (!sharedByModule.has(canon)) sharedByModule.set(canon, []);
                sharedByModule.get(canon).push(it);
              }

              // Plans that the shared library has newer than this machine (to refresh the local
              // cache) and plans only this machine has (to push up), collected during the merge.
              const refreshedFromShared = [];
              const localOnlyToPush = [];

              const mergedModules = ALLOWED_MODULES.map((module) => {
                const sharedItems = sharedByModule.get(module) || [];
                const localMod = (localData.modules || []).find((m) => m.module.toLowerCase() === module.toLowerCase());
                const localWfs = localMod?.workflows || [];

                const workflows = [];
                const seenTitles = new Set();

                for (const it of sharedItems) {
                  if (dismissedSet.has(it.title) || it.dismissed || it.status === 'dismissed') continue;
                  const titleKey = it.title.toLowerCase();
                  seenTitles.add(titleKey);
                  const localMatch = localWorkflowMap.get(`${module.toLowerCase()}::${titleKey}`);
                  // The plan (steps, sources, prerequisites, …) comes from whichever copy is newer:
                  // the shared row's plan — written by whoever last edited it on any machine — or
                  // this machine's data/workflows.json. Coverage state (status, linked script) is
                  // always the shared row's. A newer shared plan is also written back into the
                  // local file below, so this install converges without anyone running git pull.
                  let plan = localMatch || null;
                  if (sharedPlanIsNewer(it, localMatch)) {
                    plan = { ...(localMatch || {}), ...it.plan, title: it.title, planUpdatedAt: it.plan_updated_at, planUpdatedBy: it.plan_updated_by || null };
                    refreshedFromShared.push({ module, workflow: plan });
                  }
                  workflows.push({
                    title: it.title,
                    purpose: plan?.purpose || it.description || '',
                    startRoute: plan?.startRoute || it.start_route || `/${candSlug(module)}`,
                    trigger: it.trigger || plan?.trigger || '',
                    priority: it.priority || plan?.priority || 'medium',
                    steps: plan?.steps?.length ? plan.steps : [
                      `Navigate to ${module} > ${(it.start_route || '').split('/').filter(Boolean).pop() || 'overview'}`,
                      `Follow the steps for ${it.title}`
                    ],
                    evidence: plan?.evidence || [],
                    sources: plan?.sources || [it.source_file].filter(Boolean),
                    prerequisites: Array.isArray(plan?.prerequisites) ? plan.prerequisites : [],
                    provisionable: plan?.provisionable || null,
                    blockerReason: plan?.blockerReason || '',
                    suggestedSetupSteps: Array.isArray(plan?.suggestedSetupSteps) ? plan.suggestedSetupSteps : [],
                    fileFixtureKind: plan?.fileFixtureKind || null,
                    grounding: plan?.grounding || null,
                    autoRecordBlocker: autoRecordBlocker(plan),
                    planUpdatedAt: plan?.planUpdatedAt || it.plan_updated_at || null,
                    planUpdatedBy: plan?.planUpdatedBy || it.plan_updated_by || null,
                    linkedScript: it.linked_script || null,
                    status: it.status || 'missing',
                    // The panel's own To-Record filter also excludes a workflow whose title
                    // fuzzy-matches a live Pylon article, independent of status/linkedScript — the
                    // same problem the server's no_auto_match flag was built to solve, just on the
                    // client side. Forward it so "Revert to To Record" overrides that check too;
                    // otherwise a title that still has a (correctly still-published) article stays
                    // permanently invisible in To Record no matter how many times it's reverted.
                    noAutoMatch: !!it.no_auto_match
                  });
                }

                for (const lWf of localWfs) {
                  if (!seenTitles.has(lWf.title.toLowerCase()) && !dismissedSet.has(lWf.title)) {
                    workflows.push(lWf);
                    if (planPayload(lWf)) localOnlyToPush.push({ module, wf: lWf });
                  }
                }

                return { module, workflows };
              });

              // Converge this machine's data/workflows.json on the shared plans that were newer.
              if (refreshedFromShared.length) {
                try {
                  const local = fs.existsSync(WORKFLOWS_FILE) ? JSON.parse(fs.readFileSync(WORKFLOWS_FILE, 'utf8')) : { modules: [] };
                  if (!Array.isArray(local.modules)) local.modules = [];
                  for (const { module, workflow } of refreshedFromShared) {
                    let mod = local.modules.find((m) => m.module.toLowerCase() === module.toLowerCase());
                    if (!mod) { mod = { module, workflows: [] }; local.modules.push(mod); }
                    const idx = mod.workflows.findIndex((w) => w.title.toLowerCase() === workflow.title.toLowerCase());
                    const merged = { ...(idx >= 0 ? mod.workflows[idx] : { status: 'missing' }), ...workflow };
                    if (idx >= 0) mod.workflows[idx] = merged; else mod.workflows.push(merged);
                  }
                  fs.writeFileSync(WORKFLOWS_FILE, JSON.stringify(local, null, 2) + '\n');
                  localData = local;
                  console.log(`[workflows] refreshed ${refreshedFromShared.length} plan(s) from the shared library`);
                } catch (e) {
                  console.warn('[workflows] Could not write refreshed plans to workflows.json:', e.message);
                }
              }

              // And push plans only this machine has (e.g. edited before the shared plan column
              // existed, or generated while offline) so everyone else picks them up. Fire-and-forget:
              // the response shouldn't wait on it, and a failure just means we try again next time.
              const toPush = localOnlyToPush.filter(({ module, wf }) => !pushedPlanKeys.has(candSlug(`${module}-${wf.title}`)));
              if (toPush.length) {
                const candidates = toPush.map(({ module, wf }) => ({
                  key: candSlug(`${module}-${wf.title}`), module, title: wf.title,
                  description: wf.purpose || '', start_route: wf.startRoute || `/${candSlug(module)}`,
                  source_file: wf.sources?.[0] || null, priority: wf.priority || 'medium', plan: planPayload(wf),
                }));
                for (const c of candidates) pushedPlanKeys.add(c.key);
                libraryFetch('POST', null, { candidates, full_scan: false, updated_by: WHOAMI }, COVERAGE_URL)
                  .then(() => { invalidateCoverageCache(); console.log(`[workflows] pushed ${candidates.length} local-only plan(s) to the shared library`); })
                  .catch((e) => { for (const c of candidates) pushedPlanKeys.delete(c.key); console.warn('[workflows] Could not push local-only plans:', e.message); });
              }

              // Add "Other" section at the bottom of the 6 modules
              const otherWorkflows = [];
              for (const it of sharedCov.items) {
                if (dismissedSet.has(it.title) || it.dismissed || it.status === 'dismissed') continue;
                const canon = canonicalModule(it.module);
                if (!canon) {
                  otherWorkflows.push({
                    title: it.title,
                    purpose: it.description || '',
                    startRoute: it.start_route || '/overview',
                    trigger: it.trigger || '',
                    priority: it.priority || 'medium',
                    steps: [
                      `Navigate to ${it.module} > ${(it.start_route || '').split('/').filter(Boolean).pop() || 'overview'}`,
                      `Follow the steps for ${it.title}`
                    ],
                    evidence: [],
                    sources: [it.source_file].filter(Boolean),
                    linkedScript: it.linked_script || null,
                    status: it.status || 'missing',
                    // The panel's own To-Record filter also excludes a workflow whose title
                    // fuzzy-matches a live Pylon article, independent of status/linkedScript — the
                    // same problem the server's no_auto_match flag was built to solve, just on the
                    // client side. Forward it so "Revert to To Record" overrides that check too;
                    // otherwise a title that still has a (correctly still-published) article stays
                    // permanently invisible in To Record no matter how many times it's reverted.
                    noAutoMatch: !!it.no_auto_match
                  });
                }
              }
              const localOther = (localData.modules || []).find((m) => m.module.toLowerCase() === 'other');
              if (localOther?.workflows) {
                for (const w of localOther.workflows) {
                  if (!dismissedSet.has(w.title) && !otherWorkflows.some((o) => o.title.toLowerCase() === w.title.toLowerCase())) {
                    otherWorkflows.push(w);
                  }
                }
              }

              mergedModules.push({
                module: 'Other',
                workflows: otherWorkflows
              });

              return sendJson(res, 200, {
                ok: true,
                scannedAt: sharedCov.summary?.last_scan_at || localData.scannedAt || new Date().toISOString(),
                modules: mergedModules,
                manualLinks: [...manualLinksSet],
                dismissed: [...dismissedSet],
                scan: liteScan,
                shared: true
              });
            }
          } catch (netErr) {
            console.warn('[workflows] Shared repository fetch failed, falling back to local:', netErr.message);
          }
        }

        return sendJson(res, 200, {
          ok: true,
          ...localData,
          manualLinks: [...manualLinksSet],
          dismissed: [...dismissedSet],
          scan: liteScan,
          shared: false
        });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String(e?.message || e) });
      }
    }
    if (req.method === 'POST') {
      if (liteScan.running) return sendJson(res, 409, { ok: false, error: 'a scan is already running', scan: liteScan });
      liteScan = { running: true, startedAt: new Date().toISOString(), finishedAt: null, log: [], error: null };
      const log = (message) => { liteScan.log.push(String(message)); if (liteScan.log.length > 200) liteScan.log.shift(); };
      void (async () => {
        try {
          let existingWorkflows = [];
          if (fs.existsSync(WORKFLOWS_FILE)) {
            try {
              const ld = JSON.parse(fs.readFileSync(WORKFLOWS_FILE, 'utf8'));
              for (const m of ld.modules || []) {
                for (const w of m.workflows || []) {
                  existingWorkflows.push({ module: m.module, ...w });
                }
              }
            } catch (_) {}
          }
          if (LIBRARY_SECRET) {
            try {
              const sc = await libraryFetch('GET', null, null, COVERAGE_URL);
              if (sc && Array.isArray(sc.items)) {
                for (const it of sc.items) {
                  if (!existingWorkflows.some((e) => e.title.toLowerCase() === it.title.toLowerCase())) {
                    existingWorkflows.push(it);
                  }
                }
              }
            } catch (_) {}
          }

          const { runScan } = await import('./coverage-scan.mjs');
          const result = await runScan({ useCache: false, log, existingWorkflows });
          const modules = ALLOWED_MODULES.map((module) => ({
            module,
            workflows: (result.candidates || []).filter((workflow) => workflow.module === module).map((workflow) => ({
              title: workflow.title,
              purpose: workflow.description || '',
              startRoute: workflow.start_route,
              trigger: workflow.trigger,
              priority: workflow.priority,
              steps: (workflow.steps || []).map((step) => step.instruction).filter(Boolean),
              evidence: (workflow.steps || []).map((step) => ({ instruction: step.instruction, route: step.route, controlLabel: step.control_label, ...step.evidence })),
              sources: workflow.sources || [],
              prerequisites: workflow.prerequisites || [],
              provisionable: workflow.provisionable || null,
              blockerReason: workflow.blocker_reason || '',
              grounding: workflow.grounding || null,
              planUpdatedAt: new Date().toISOString(),
              planUpdatedBy: WHOAMI
            }))
          }));
          if (modules.some((entry) => entry.workflows.length)) {
            fs.mkdirSync(path.dirname(WORKFLOWS_FILE), { recursive: true });
            fs.writeFileSync(WORKFLOWS_FILE, JSON.stringify({ scannedAt: new Date().toISOString(), modules }, null, 2));

            if (LIBRARY_SECRET) {
              try {
                const candidates = [];
                for (const m of modules) {
                  for (const w of m.workflows) {
                    candidates.push({
                      module: m.module,
                      title: w.title,
                      description: w.purpose || '',
                      start_route: w.startRoute,
                      trigger: w.trigger,
                      source_file: w.sources?.[0] || null,
                      priority: w.priority || 'medium',
                      plan: planPayload(w)
                    });
                  }
                }
                await libraryFetch('POST', null, { candidates, full_scan: false, updated_by: WHOAMI }, COVERAGE_URL);
                log('✓ Synced scan to shared team repository (Neon).');
              } catch (sharedErr) {
                console.warn('[workflows] Could not sync scan to shared repository:', sharedErr.message);
              }
            }
          }
          liteScan = { ...liteScan, running: false, finishedAt: new Date().toISOString() };
        } catch (e) {
          liteScan = { ...liteScan, running: false, finishedAt: new Date().toISOString(), error: withAuthHint(e?.message || e) };
        }
      })();
      return sendJson(res, 202, { ok: true, scan: liteScan });
    }
  }

  if (req.method === 'POST' && u.pathname === '/plan/generate') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const userPrompt = String(payload.userPrompt || '').trim();
        if (!userPrompt) throw new Error('Please describe the walkthrough idea or goal.');
        const plan = await generatePlanFromIdea({
          userPrompt,
          previousPlan: payload.previousPlan || null,
          clarification: payload.clarification ? String(payload.clarification).trim() : null
        });
        return sendJson(res, 200, { ok: true, plan });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: String(e?.message || e) });
      }
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/workflows/enhance') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { module: modName, workflow, clarification } = JSON.parse(body || '{}');
        if (!workflow?.title) throw new Error('workflow title required');
        const targetModule = canonicalModule(modName || workflow.module) || modName || 'Testing program';

        const defaultClarification = 'Inspect the codebase for this specific workflow and formulate an exhaustive, granular step-by-step walkthrough plan referencing exact visible button labels, fields, and dialog controls.';
        const enhancedPlan = await generatePlanFromIdea({
          userPrompt: `${workflow.title} in ${targetModule}`,
          previousPlan: {
            title: workflow.title,
            module: targetModule,
            startRoute: workflow.startRoute || workflow.start_route,
            summary: workflow.purpose || workflow.description,
            steps: Array.isArray(workflow.steps) ? workflow.steps : []
          },
          clarification: clarification ? `${clarification}\n\n${defaultClarification}` : defaultClarification
        });

        return sendJson(res, 200, { ok: true, plan: enhancedPlan });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: String(e?.message || e) });
      }
    });
    return;
  }

  // ---- Ground a brand-new step being manually inserted into a plan ----
  if (req.method === 'POST' && u.pathname === '/workflows/step/ground') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { module: modName, workflow, steps, insertAt, rawIdea } = JSON.parse(body || '{}');
        if (!rawIdea?.trim()) throw new Error('rawIdea required — describe what this step should do');
        const result = await groundNewStepFromCodebase({ module: modName, workflow, steps, insertAt: Number.isInteger(insertAt) ? insertAt : (steps?.length || 0), rawIdea });
        return sendJson(res, 200, { ok: true, ...result });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: String(e?.message || e) });
      }
    });
    return;
  }

  // ---- Per-step "Edit with AI": refine or re-verify ONE existing step ----
  if (req.method === 'POST' && u.pathname === '/workflows/step/refine') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { module: modName, workflow, steps, stepIndex, instruction } = JSON.parse(body || '{}');
        if (!Number.isInteger(stepIndex)) throw new Error('stepIndex required');
        const result = await refineStepWithCodebase({ module: modName, workflow, steps, stepIndex, instruction });
        return sendJson(res, 200, { ok: true, ...result });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: String(e?.message || e) });
      }
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/workflows/opportunity') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { module: modName, workflow } = JSON.parse(body || '{}');
        if (!workflow?.title) throw new Error('workflow title required');
        const targetModule = canonicalModule(modName || workflow.module) || modName || 'Testing program';
        const title = workflow.title.trim();

        // 1. Remove from dismissed-workflows.json and manual-links.json if present
        const dismissed = new Set(readDismissedWorkflows());
        if (dismissed.delete(title)) writeDismissedWorkflows([...dismissed]);

        const links = new Set(readManualLinks());
        if (links.delete(title)) writeManualLinks([...links]);

        // 2. Add or update in local data/workflows.json
        try {
          let data = { modules: [] };
          if (fs.existsSync(WORKFLOWS_FILE)) {
            data = JSON.parse(fs.readFileSync(WORKFLOWS_FILE, 'utf8'));
          }
          if (!Array.isArray(data.modules)) data.modules = [];
          let targetModObj = data.modules.find((m) => m.module.toLowerCase() === targetModule.toLowerCase());
          if (!targetModObj) {
            targetModObj = { module: targetModule, workflows: [] };
            data.modules.push(targetModObj);
          }
          if (!Array.isArray(targetModObj.workflows)) targetModObj.workflows = [];

          const existingIdx = targetModObj.workflows.findIndex((w) => w.title.toLowerCase() === title.toLowerCase());
          const fullWf = {
            title,
            purpose: workflow.summary || workflow.purpose || '',
            startRoute: workflow.startRoute || workflow.start_route || '/overview',
            trigger: workflow.trigger || '',
            priority: workflow.priority || 'medium',
            steps: Array.isArray(workflow.steps) ? workflow.steps : [],
            evidence: workflow.evidence || [],
            sources: workflow.sources || [workflow.source_file].filter(Boolean),
            prerequisites: Array.isArray(workflow.prerequisites) ? workflow.prerequisites : [],
            provisionable: workflow.provisionable || null,
            blockerReason: workflow.blockerReason || '',
            suggestedSetupSteps: Array.isArray(workflow.suggestedSetupSteps) ? workflow.suggestedSetupSteps : [],
            fileFixtureKind: workflow.fileFixtureKind || null,
            // A plan whose steps were changed without re-verifying (hand edits) has no grounding
            // record, which correctly hides Auto-record until Enhance re-grounds it.
            grounding: workflow.grounding && typeof workflow.grounding === 'object' ? workflow.grounding : null,
            status: 'missing',
            planUpdatedAt: new Date().toISOString(),
            planUpdatedBy: WHOAMI
          };
          if (existingIdx >= 0) {
            targetModObj.workflows[existingIdx] = fullWf;
          } else {
            targetModObj.workflows.unshift(fullWf);
          }
          fs.writeFileSync(WORKFLOWS_FILE, JSON.stringify(data, null, 2));
        } catch (fileErr) {
          console.warn('[workflows/opportunity] Could not write to local workflows.json:', fileErr.message);
        }

        // 3. Upsert into shared Neon repository (hadrius_studio_beta_workflow_candidates)
        if (LIBRARY_SECRET) {
          try {
            const candKey = candSlug(`${targetModule}-${title}`);
            await libraryFetch('POST', null, {
              candidates: [{
                key: candKey,
                module: targetModule,
                title,
                description: workflow.summary || workflow.purpose || '',
                start_route: workflow.startRoute || workflow.start_route || '/overview',
                source_file: workflow.sources?.[0] || workflow.source_file || null,
                priority: 'medium',
                updated_by: WHOAMI,
                plan: planPayload({
                  purpose: workflow.summary || workflow.purpose || '',
                  startRoute: workflow.startRoute || workflow.start_route || '/overview',
                  trigger: workflow.trigger || '',
                  priority: workflow.priority || 'medium',
                  steps: Array.isArray(workflow.steps) ? workflow.steps : [],
                  evidence: workflow.evidence || [],
                  sources: workflow.sources || [workflow.source_file].filter(Boolean),
                  prerequisites: Array.isArray(workflow.prerequisites) ? workflow.prerequisites : [],
                  provisionable: workflow.provisionable || null,
                  blockerReason: workflow.blockerReason || '',
                  suggestedSetupSteps: Array.isArray(workflow.suggestedSetupSteps) ? workflow.suggestedSetupSteps : [],
                  fileFixtureKind: workflow.fileFixtureKind || null,
                  grounding: workflow.grounding && typeof workflow.grounding === 'object' ? workflow.grounding : null,
                })
              }],
              full_scan: false
            }, COVERAGE_URL);
          } catch (sharedErr) {
            console.warn('[workflows/opportunity] Could not upsert to shared repository:', sharedErr.message);
          }
        }

        invalidateCoverageCache();
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: String(e?.message || e) });
      }
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/workflows/dismiss') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { title, module: modName } = JSON.parse(body || '{}');
        if (!title) throw new Error('title required');
        const dismissed = new Set(readDismissedWorkflows());
        dismissed.add(title);
        writeDismissedWorkflows([...dismissed]);

        // Also remove from local workflows.json if present
        if (fs.existsSync(WORKFLOWS_FILE)) {
          try {
            const data = JSON.parse(fs.readFileSync(WORKFLOWS_FILE, 'utf8'));
            if (Array.isArray(data.modules)) {
              for (const mod of data.modules) {
                if (Array.isArray(mod.workflows)) {
                  mod.workflows = mod.workflows.filter((w) => w.title.toLowerCase() !== title.toLowerCase());
                }
              }
              fs.writeFileSync(WORKFLOWS_FILE, JSON.stringify(data, null, 2));
            }
          } catch (_) {}
        }

        // Delete or mark dismissed in shared Neon repository
        if (LIBRARY_SECRET) {
          try {
            const targetModule = modName || 'Testing program';
            const candKey = candSlug(`${targetModule}-${title}`);
            await libraryFetch('DELETE', { key: candKey }, null, COVERAGE_URL);
          } catch (sharedErr) {
            console.warn('[workflows/dismiss] Could not delete from shared repository:', sharedErr.message);
          }
        }

        invalidateCoverageCache();
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: String(e?.message || e) });
      }
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/workflows/link') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { title, module: modName, unmark = false } = JSON.parse(body);
        if (!title) throw new Error('title required');
        const links = new Set(readManualLinks());
        if (unmark) links.delete(title);
        else links.add(title);
        const arr = [...links];
        writeManualLinks(arr);
        invalidateCoverageCache();

        if (LIBRARY_SECRET) {
          try {
            const targetModule = modName || 'Testing program';
            const candKey = candSlug(`${targetModule}--${title}`);
            // "status" isn't a stored column on this row at all — the coverage endpoint derives it
            // live by fuzzy-matching this row's TITLE against every script in the shared scripts
            // table, independent of linked_script. That's why clearing linked_script alone never
            // made "Revert to To Record" stick for a workflow with a real recording already in the
            // shared library: the very next GET found the same script by title similarity and
            // re-derived status: 'covered' regardless. The server now sets its own no_auto_match
            // flag whenever linked_script is explicitly cleared here (see studio-beta-coverage.ts),
            // which skips that fuzzy match entirely — nothing else needs to change on this end.
            await libraryFetch('PATCH', null, {
              key: candKey,
              linked_script: unmark ? null : (title || 'linked'),
              dismissed: !unmark,
              updated_by: WHOAMI
            }, COVERAGE_URL);
          } catch (sharedErr) {
            console.warn('[workflows/link] Could not sync to shared repository:', sharedErr.message);
          }
        }

        return sendJson(res, 200, { ok: true, manualLinks: arr });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: String(e?.message || e) });
      }
    });
    return;
  }

  // ---- Workflow AI Recording: drive browser with Playwright using the enhanced plan ----
  if (req.method === 'POST' && u.pathname === '/workflows/ai-record/stop') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { key } = JSON.parse(body || '{}');
        let stoppedAny = false;
        if (key) {
          const job = aiJobs.get(key);
          if (job && aiBusy(job)) {
            job.controller?.abort();
            job.state = 'failed';
            job.error = 'Cancelled by user';
            stoppedAny = true;
          }
        } else {
          for (const [k, job] of aiJobs.entries()) {
            if (aiBusy(job)) {
              job.controller?.abort();
              job.state = 'failed';
              job.error = 'Cancelled by user';
              stoppedAny = true;
            }
          }
        }
        return sendJson(res, 200, { ok: true, message: stoppedAny ? 'AI recording stopped' : 'No running job' });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: String(e?.message || e) });
      }
    });
    return;
  }

  if (u.pathname === '/workflows/ai-record') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          const { module: modName, workflow } = JSON.parse(body || '{}');
          if (!workflow?.title) throw new Error('workflow title required');
          const targetModule = canonicalModule(modName || workflow.module) || modName || 'Testing program';
          const title = workflow.title.trim();
          const startRoute = workflow.startRoute || workflow.start_route || '/overview';
          const key = candSlug(`${targetModule}-${title}`);

          const item = {
            key,
            title,
            module: targetModule,
            start_route: startRoute,
            description: workflow.purpose || workflow.summary || '',
            trigger: workflow.trigger || '',
            steps: Array.isArray(workflow.steps) ? workflow.steps : [],
            prerequisites: Array.isArray(workflow.prerequisites) ? workflow.prerequisites : []
          };

          const blocker = autoRecordBlocker({ steps: item.steps, provisionable: workflow.provisionable, grounding: workflow.grounding });
          if (blocker) return sendJson(res, 400, { ok: false, error: `Auto-record is unavailable for this plan: ${blocker}. Record it manually, or run Enhance plan so every step is verified first.` });

          const existing = aiJobs.get(key);
          if (existing && aiBusy(existing)) {
            return sendJson(res, 200, { ok: true, key, message: 'AI recording already running', job: aiJobView(existing) });
          }

          if (item.steps.length) {
            const normSteps = item.steps.map((s) => (typeof s === 'string' ? { instruction: s } : s));
            setPlan(key, { title, module: targetModule, steps: normSteps, summary: item.description, prerequisites: item.prerequisites }, title);
          }

          aiJobs.set(key, {
            state: 'queued',
            startedAt: null,
            finishedAt: null,
            log: [`Queued AI browser recording for "${title}"…`],
            error: null,
            result: null,
            item,
            controller: new AbortController()
          });

          aiQueue.push(key);
          pumpAiQueue();

          return sendJson(res, 202, { ok: true, key, message: `Queued AI recording for "${title}"` });
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: String(e?.message || e) });
        }
      });
      return;
    }

    if (req.method === 'GET') {
      const key = u.searchParams.get('key');
      if (!key) {
        const jobs = {};
        for (const [k, v] of aiJobs.entries()) jobs[k] = aiJobView(v);
        return sendJson(res, 200, { ok: true, jobs });
      }
      const job = aiJobs.get(key);
      if (!job) return sendJson(res, 404, { ok: false, error: 'Job not found' });
      return sendJson(res, 200, { ok: true, job: aiJobView(job, { full: true }) });
    }
  }

  if (req.method === 'GET' && u.pathname === '/pylon/articles') {
    try {
      const articles = await pylonListArticles();
      const articleScriptIndex = buildArticleScriptIndex();
      const modules = {};
      for (const [module, collectionId] of Object.entries(PYLON_MODULE_COLLECTION_MAP)) {
        const entry = {
          collectionId,
          collectionUrl: `https://app.usepylon.com/kb/${PYLON_KNOWLEDGE_BASE_ID}/collections/${collectionId}`,
          articles: articles.filter((article) => article.collection_id === collectionId).map((article) => {
            const linked = articleScriptIndex.get(String(article.id));
            return {
              id: article.id, title: article.title, url: pylonArticleUrl(article), isPublished: !!article.is_published,
              visibility: article.visibility_config?.visibility || 'internal_only', updatedAt: article.last_edited_at || article.created_at,
              linkedScript: linked?.scriptName || null,
              driveVideoUrl: linked?.driveVideoUrl || null
            };
          })
        };
        const canon = ALLOWED_MODULES.find((m) => m.toLowerCase() === module.toLowerCase()) || module;
        modules[canon] = entry;
      }

      return sendJson(res, 200, { ok: true, modules, syncedAt: new Date().toISOString() });
    } catch (e) { return sendJson(res, 502, { ok: false, error: String(e?.message || e) }); }
  }

  // ---- shared script library (proxied to Vercel/Neon; secret stays in .env on this machine) ----
  if (u.pathname === '/library') {
    try {
      if (req.method === 'GET') {
        const name = u.searchParams.get('name');
        if (name) {
          const sName = safeName(name);
          const localScriptPath = path.join(REPO_ROOT, 'scripts', `${sName}.script.json`);
          if (fs.existsSync(localScriptPath)) {
            try {
              const sc = JSON.parse(fs.readFileSync(localScriptPath, 'utf8'));
              return sendJson(res, 200, { ok: true, item: { name, script: sc } });
            } catch (_) {}
          }
          if (LIBRARY_SECRET) {
            try {
              const remote = await libraryFetch('GET', { name });
              if (remote?.item) return sendJson(res, 200, { ok: true, ...remote });
            } catch (_) {}
          }
          return sendJson(res, 404, { ok: false, error: `Script "${name}" not found` });
        }

        let remoteItems = [];
        if (LIBRARY_SECRET) {
          try {
            const remote = await libraryFetch('GET', u.searchParams.get('attention') ? { attention: '1' } : null);
            remoteItems = remote.items || [];
          } catch (e) {
            console.warn('[library] Remote fetch failed:', e.message);
          }
        }

        const localItems = [];
        const scriptsDir = path.join(REPO_ROOT, 'scripts');
        if (fs.existsSync(scriptsDir)) {
          for (const f of fs.readdirSync(scriptsDir)) {
            if (!f.endsWith('.script.json')) continue;
            try {
              const sc = JSON.parse(fs.readFileSync(path.join(scriptsDir, f), 'utf8'));
              const sName = sc.name || f.replace('.script.json', '');
              const sTitle = formatHumanTitle(sc.title || sc.name || sName);
              const mName = safeName(sName);
              const mp4Path = path.join(REPO_ROOT, 'out', mName, `${mName}.mp4`);
              localItems.push({
                name: sName,
                title: sTitle,
                module: sc.module || '',
                step_count: Array.isArray(sc.steps) ? sc.steps.length : 0,
                start_url: sc.environment?.startUrl || null,
                updated_at: sc.updatedAt || sc.createdAt || null,
                updated_by: sc.updated_by || 'local',
                mp4_ready: fs.existsSync(mp4Path),
                local: true
              });
            } catch (_) {}
          }
        }

        const seenNames = new Set();
        const merged = [];
        for (const r of remoteItems) {
          const sName = r.name;
          seenNames.add(sName.toLowerCase());
          const mName = safeName(sName);
          const mp4Path = path.join(REPO_ROOT, 'out', mName, `${mName}.mp4`);
          merged.push({
            ...r,
            title: formatHumanTitle(r.title || r.name),
            mp4_ready: fs.existsSync(mp4Path)
          });
        }
        for (const l of localItems) {
          if (!seenNames.has(l.name.toLowerCase())) {
            merged.push(l);
          }
        }

        merged.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
        return sendJson(res, 200, { ok: true, count: merged.length, items: merged });
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        if (body.report && body.name) {
          const out = await libraryFetch('POST', null, body);
          return sendJson(res, 200, { ok: true, ...out });
        }
        if (body.healed_step_index !== undefined && body.name && !body.script) {
          const out = await libraryFetch('POST', null, body);
          return sendJson(res, 200, { ok: true, ...out });
        }
        const { script, ...extra } = body;
        if (!script || !Array.isArray(script.steps)) throw new Error('no script provided');
        const out = await saveScript(script, extra);
        return sendJson(res, 200, { ok: true, ...out });
      }
      if (req.method === 'DELETE') {
        const name = u.searchParams.get('name'); if (!name) throw new Error('missing name');
        const out = await libraryFetch('DELETE', { name });
        try { fs.rmSync(path.join(REPO_ROOT, 'scripts', `${name}.script.json`), { force: true }); } catch (_) {}
        return sendJson(res, 200, { ok: true, ...out });
      }
    } catch (e) { return sendJson(res, 400, { ok: false, error: String(e?.message || e) }); }
  }

  // ---- workflow coverage: candidates discovered from the codebase vs. saved scripts ----
  if (u.pathname === '/coverage') {
    try {
      if (req.method === 'GET') return sendJson(res, 200, { ok: true, ...filterCoverage(await libraryFetch('GET', null, null, COVERAGE_URL)) });
      if (req.method === 'PATCH') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, { ok: true, ...(await libraryFetch('PATCH', null, { ...body, updated_by: WHOAMI }, COVERAGE_URL)) });
      }
      if (req.method === 'DELETE') {
        const key = u.searchParams.get('key'); if (!key) throw new Error('missing key');
        return sendJson(res, 200, { ok: true, ...(await libraryFetch('DELETE', { key }, null, COVERAGE_URL)) });
      }
      if (req.method === 'POST') { // direct upsert of candidates (used by cron / CLI)
        const body = await readJsonBody(req);
        return sendJson(res, 200, { ok: true, ...(await libraryFetch('POST', null, { ...body, updated_by: body.updated_by || WHOAMI }, COVERAGE_URL)) });
      }
    } catch (e) { return sendJson(res, 400, { ok: false, error: String(e?.message || e) }); }
  }
  if (u.pathname === '/coverage/scan') {
    // Long-running: kick off in the background and let the panel poll /coverage/scan for progress.
    if (req.method === 'GET') return sendJson(res, 200, { ok: true, ...coverageScan });
    if (req.method === 'POST') {
      if (coverageScan.running) return sendJson(res, 409, { ok: false, error: 'a scan is already running', ...coverageScan });
      try { await requireClaudeAuth(); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message, claude_auth: claudeAuth }); }
      let body = {}; try { body = await readJsonBody(req); } catch (_) {}
      coverageScan = { running: true, startedAt: new Date().toISOString(), log: [], result: null, error: null };
      const log = (m) => { coverageScan.log.push(m); if (coverageScan.log.length > 200) coverageScan.log.shift(); };
      (async () => {
        try {
          let existingWorkflows = [];
          if (LIBRARY_SECRET) {
            try {
              const sc = await libraryFetch('GET', null, null, COVERAGE_URL);
              if (sc && Array.isArray(sc.items)) existingWorkflows = sc.items;
            } catch (_) {}
          }
          const { runScan } = await import('./coverage-scan.mjs');
          const r = await runScan({ onlyModule: body.module || null, log, useCache: body.rediscover !== true, existingWorkflows });
          const out = await libraryFetch('POST', null, { candidates: r.candidates, full_scan: r.full_scan, updated_by: WHOAMI }, COVERAGE_URL);
          log(`Saved ${out.upserted} candidates${out.pruned ? `, pruned ${out.pruned} stale` : ''}.`);
          // Start preparing step-by-step plans for every new workflow right away, in the background.
          try {
            const cov = filterCoverage(await libraryFetch('GET', null, null, COVERAGE_URL));
            const n = queuePlans(cov.items.filter((i) => i.status === 'missing'));
            if (n) log(`Preparing plans for ${n} workflow(s) in the background (${PLAN_CONCURRENCY} at a time).`);
          } catch (_) {}
          coverageScan = { ...coverageScan, running: false, finishedAt: new Date().toISOString(), result: { modules: r.modules.length, candidates: r.candidates.length, errors: r.errors, ...out } };
        } catch (e) {
          coverageScan = { ...coverageScan, running: false, finishedAt: new Date().toISOString(), error: withAuthHint(e?.message || e) };
        }
      })();
      return sendJson(res, 202, { ok: true, started: true });
    }
  }

  // ---- workflow plans: background generation status / kick-off ----
  // ---- "▶ AI" on one Workflow-guide step: decide the single action for the live page snapshot ----
  if (req.method === 'POST' && u.pathname === '/act') {
    try {
      const body = await readJsonBody(req);
      if (!body.step?.instruction || !body.snapshot?.elements) throw new Error('step and snapshot required');
      await requireClaudeAuth();
      const { decideSingleStep } = await loadAiRecord();
      const decision = await decideSingleStep(body);
      return sendJson(res, 200, { ok: true, ...decision });
    } catch (e) { return sendJson(res, 400, { ok: false, error: withAuthHint(e?.message || e) }); }
  }

  if (u.pathname === '/coverage/plans') {
    if (req.method === 'GET') return sendJson(res, 200, { ok: true, ...planStatus() });
    if (req.method === 'POST') { // queue plans for items that lack one (optionally only `keys`); idempotent
      try {
        let body = {}; try { body = await readJsonBody(req); } catch (_) {}
        const a = await checkClaudeAuth();
        if (a.loggedIn === false) return sendJson(res, 200, { ok: true, queued: 0, skipped: 'claude signed out', ...planStatus() });
        const cov = filterCoverage(await libraryFetch('GET', null, null, COVERAGE_URL));
        let items = cov.items.filter((i) => i.status === 'missing' || i.status === 'attention' || i.status === 'untested');
        if (Array.isArray(body.keys) && body.keys.length) { const want = new Set(body.keys); items = cov.items.filter((i) => want.has(i.key)); for (const k of body.keys) delete planFailed[k]; }
        if (body.force && Array.isArray(body.keys)) for (const k of body.keys) delete plans[k];
        const n = queuePlans(items);
        return sendJson(res, 202, { ok: true, queued: n, ...planStatus() });
      } catch (e) { return sendJson(res, 400, { ok: false, error: String(e?.message || e) }); }
    }
  }

  // ---- AI-driven recording: drive an isolated browser through a missing workflow automatically ----
  if (u.pathname === '/coverage/ai-record') {
    if (req.method === 'GET') {
      evictAiJobs();
      const jobs = {};
      for (const [key, j] of aiJobs) jobs[key] = aiJobView(j);
      return sendJson(res, 200, { ok: true, jobs, active: aiActive, concurrency: AI_RECORD_CONCURRENCY, claude_auth: claudeAuth });
    }
    if (req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const keys = Array.isArray(body.keys) ? body.keys : (body.key ? [body.key] : []);
        if (!keys.length) throw new Error('missing keys');
        await requireClaudeAuth(); // before cloning profiles and opening browsers that would all fail
        const cov = filterCoverage(await libraryFetch('GET', null, null, COVERAGE_URL));
        const started = [];
        const now = new Date().toISOString();
        for (const key of keys) {
          const existing = aiJobs.get(key);
          if (existing && aiBusy(existing)) continue;
          const item = cov.items.find((i) => i.key === key);
          if (!item) { aiJobs.set(key, { state: 'failed', startedAt: null, finishedAt: now, error: 'coverage item not found — try reloading the panel', log: [], result: null }); continue; }
          // Enforced here, not just hidden in the panel: a stale panel, the bulk path, or a direct
          // POST would otherwise still spend 20-40 browser turns on a workflow known not to work.
          if (item.ai_record !== 'ok') {
            const why = item.ai_record === 'blocked'
              ? `Create with AI is blocked for this workflow — record it by hand. ${item.ai_note || ''}`.trim()
              : 'Create with AI is not enabled for this workflow yet (nobody has confirmed the agent can complete it) — record it by hand, or mark it ai_record:"ok" in tools/coverage-taxonomy.json once you have seen it work.';
            aiJobs.set(key, { state: 'failed', startedAt: null, finishedAt: now, error: why, log: [], result: null });
            continue;
          }
          // The controller exists from the moment the job is queued, so a cancel that lands before
          // the job starts (or during the module import) is honoured rather than lost.
          aiJobs.set(key, { state: 'queued', startedAt: null, finishedAt: null, log: [`Queued "${item.title}"…`], error: null, result: null, item, controller: new AbortController() });
          aiQueue.push(key);
          started.push(key);
        }
        pumpAiQueue();
        return sendJson(res, 202, { ok: true, started, queued: aiQueue.length });
      } catch (e) { return sendJson(res, 400, { ok: false, error: String(e?.message || e) }); }
    }
    if (req.method === 'DELETE') {
      const key = u.searchParams.get('key'); if (!key) return sendJson(res, 400, { ok: false, error: 'missing key' });
      const job = aiJobs.get(key);
      if (job && aiBusy(job)) {
        const qi = aiQueue.indexOf(key);
        if (qi !== -1) { // never started: fail it here, nothing else will
          aiQueue.splice(qi, 1);
          job.state = 'failed'; job.error = 'cancelled'; job.finishedAt = new Date().toISOString(); job.item = null;
          aiLog(key, 'Cancelled before it started.');
        } else {
          aiLog(key, 'Cancelling…');
        }
        job.controller?.abort(); // running: aborts the claude child + closes the browser; the job's own finally records the outcome
      }
      return sendJson(res, 200, { ok: true });
    }
  }

  // ---- is the `claude` CLI signed in on this machine? (?fresh=1 bypasses the 60s cache) ----
  if (req.method === 'GET' && u.pathname === '/auth') {
    return sendJson(res, 200, { ok: true, ...(await checkClaudeAuth({ maxAgeMs: u.searchParams.has('fresh') ? 0 : 60000 })) });
  }

  // ---- trigger / query Vercel health check ----
  if (u.pathname === '/health-check') {
    try {
      const out = await libraryFetch(req.method === 'POST' ? 'POST' : 'GET', null, null, HEALTH_CHECK_URL);
      return sendJson(res, 200, { ok: true, ...out });
    } catch (e) { return sendJson(res, 400, { ok: false, error: String(e?.message || e) }); }
  }

  // ---- Stephen-bot ticket decisions persistence ----
  const DECISIONS_FILE = path.join(process.env.HOME || '/Users/stephenskalamera', '.hermes', 'stephen_bot_ticket_decisions.json');
  if (u.pathname === '/ticket-decision' || u.pathname === '/ticket-decisions') {
    try {
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const issueNum = String(body.issue_number || body.number || body.id || '').trim();
        if (!issueNum) throw new Error('missing issue_number');
        let decisions = {};
        if (fs.existsSync(DECISIONS_FILE)) {
          try { decisions = JSON.parse(fs.readFileSync(DECISIONS_FILE, 'utf8')); } catch (_) {}
        }
        decisions[issueNum] = {
          approval: body.approval !== undefined ? body.approval : (decisions[issueNum]?.approval || 'pending'),
          suggested_action: body.suggested_action || decisions[issueNum]?.suggested_action || '',
          custom_instructions: body.custom_instructions !== undefined ? body.custom_instructions : (decisions[issueNum]?.custom_instructions || ''),
          action_status: body.action_status || decisions[issueNum]?.action_status || (body.approval === 'yes' ? 'approved' : body.approval === 'no' ? 'rejected' : 'pending'),
          updated_at: new Date().toISOString(),
          notes: body.notes || decisions[issueNum]?.notes || '',
        };
        fs.writeFileSync(DECISIONS_FILE, JSON.stringify(decisions, null, 2));
        return sendJson(res, 200, { ok: true, status: 'saved', item: decisions[issueNum] });
      }
      if (req.method === 'GET') {
        let decisions = {};
        if (fs.existsSync(DECISIONS_FILE)) {
          try { decisions = JSON.parse(fs.readFileSync(DECISIONS_FILE, 'utf8')); } catch (_) {}
        }
        return sendJson(res, 200, { ok: true, decisions });
      }
    } catch (e) { return sendJson(res, 400, { ok: false, error: String(e?.message || e) }); }
  }

  // ---- last render report for a script: which steps failed / healed, with the failure screenshots ----
  if (req.method === 'GET' && u.pathname === '/report') {
    try {
      const name = String(u.searchParams.get('name') || '').replace(/[^\w.-]+/g, '-');
      if (!name) throw new Error('missing name');
      const outDir = path.join(REPO_ROOT, 'out', name);
      const rp = path.join(outDir, 'report.json');
      if (!fs.existsSync(rp)) return sendJson(res, 200, { ok: true, found: false });
      const r = JSON.parse(fs.readFileSync(rp, 'utf8'));
      const failed = (r.failed || []).map((f) => {
        let shot = null;
        try {
          const sp = f.screenshot ? (path.isAbsolute(f.screenshot) ? f.screenshot : path.join(REPO_ROOT, f.screenshot)) : null;
          if (sp && fs.existsSync(sp)) shot = 'data:image/png;base64,' + fs.readFileSync(sp).toString('base64');
        } catch (_) {}
        return { step: f.step, error: f.error, class: f.class || 'ui-drift', screenshot: shot };
      });
      const gated = (r.healed || []).filter((h) => h.how === 'mutation-gated').map((h) => h.step);
      const video = fs.existsSync(path.join(outDir, `${name}.mp4`)) ? path.join(outDir, `${name}.mp4`) : null;
      return sendJson(res, 200, { ok: true, found: true, finishedAt: r.finishedAt, slides: r.slides?.length ?? 0, healed: r.healed || [], failed, gated, video, outDir, loginRequired: !!r.loginRequired, mutationsAllowed: !!r.mutationsAllowed });
    } catch (e) { return sendJson(res, 400, { ok: false, error: String(e?.message || e) }); }
  }

  // ---- does this script name render via a Phase 1 recipe? Mirrors render.sh's own lookup exactly
  // (same taxonomy file, same endswith match on the script name) so the panel's editor can tell a
  // deliberately-empty recipe-trigger script apart from a genuinely empty/unsaved one, instead of
  // disabling Save/Render on every 0-step script.
  if (req.method === 'GET' && u.pathname === '/recipe') {
    return sendJson(res, 200, { ok: true, recipe: findRecipeForScriptName(u.searchParams.get('name')) });
  }

  if (req.method === 'POST' && req.url === '/narrate') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { steps, scriptName } = JSON.parse(body);
        if (!Array.isArray(steps) || !steps.length) throw new Error('no steps provided');

        let lines = null;
        let model = 'claude';
        let fallbackReason = null;

        try {
          const result = await runClaudeCli(buildPrompt(steps, scriptName));
          const match = result.match(/\[[\s\S]*\]/);
          lines = JSON.parse(match ? match[0] : result);
        } catch (claudeErr) {
          fallbackReason = String(claudeErr?.message || claudeErr);
          console.warn(`Claude CLI failed (${fallbackReason}), falling back to gemini-3.8-flash...`);
          lines = await runGemini(steps, scriptName);
          model = 'gemini-3.8-flash';
        }

        if (!Array.isArray(lines)) throw new Error('model did not return a JSON array');
        lines = sanitizeNarrationLines(lines);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, lines, model, ...(fallbackReason ? { fallbackFrom: 'claude', fallbackReason } : {}) }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
      }
    });
    return;
  }

  // ---- narrate a recipe's own captions (renderer/from-recipe.mjs, best-effort) — same writer as
  // /narrate above, just fed a recipe's log() captions directly instead of recorded steps ----
  if (req.method === 'POST' && req.url === '/narrate-recipe') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { captions, scriptName } = JSON.parse(body);
        if (!Array.isArray(captions) || !captions.length) throw new Error('no captions provided');

        let lines = null;
        let model = 'claude';
        let fallbackReason = null;

        try {
          const prompt = buildRecipePrompt(captions, scriptName);
          const result = await runClaude(prompt, buildRecipePromptPlain(captions, scriptName));
          const match = result.match(/\[[\s\S]*\]/);
          lines = JSON.parse(match ? match[0] : result);
          if (!Array.isArray(lines)) throw new Error('Claude did not return a JSON array');
        } catch (claudeErr) {
          fallbackReason = String(claudeErr?.message || claudeErr);
          console.warn(`Claude drafting failed (${fallbackReason}), falling back to gemini-3.8-flash for recipe narration...`);
          lines = await runGeminiRecipe(captions, scriptName);
          model = 'gemini-3.8-flash';
        }

        if (!Array.isArray(lines)) throw new Error('model did not return a JSON array');
        lines = sanitizeNarrationLines(lines);
        return sendJson(res, 200, { ok: true, lines, model, ...(fallbackReason ? { fallbackFrom: 'claude', fallbackReason } : {}) });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String(e?.message || e) });
      }
    });
    return;
  }

  // ---- auto-heal broken step: inspect live candidates + Hadrius codebase via MCP ----
  if (req.method === 'POST' && req.url === '/auto-heal') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { step, candidates, route } = JSON.parse(body);
        if (!step || !Array.isArray(candidates) || !candidates.length) {
          throw new Error('step and non-empty candidates array required');
        }

        let result = null;
        let usedModel = 'claude';
        let fallbackReason = null;

        try {
          const prompt = buildAutoHealPrompt(step, candidates, route);
          const raw = await runClaude(prompt);
          const match = raw.match(/\{[\s\S]*\}/);
          result = JSON.parse(match ? match[0] : raw);
        } catch (claudeErr) {
          fallbackReason = String(claudeErr?.message || claudeErr);
          console.warn(`Claude auto-heal failed (${fallbackReason}), falling back to gemini-3.8-flash...`);
          result = await runGeminiAutoHeal(step, candidates, route);
          usedModel = 'gemini-3.8-flash';
        }

        if (!result || result.candidateId == null) {
          throw new Error('AI could not identify a confident replacement element on this page.');
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          candidateId: result.candidateId,
          confidence: result.confidence ?? 0.9,
          codeEvidence: result.codeEvidence || '',
          explanation: result.explanation || '',
          model: usedModel,
          ...(fallbackReason ? { fallbackFrom: 'claude', fallbackReason } : {})
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
      }
    });
    return;
  }

  // ---- render: save the script into scripts/ and run render.sh in the background ----
  if (req.method === 'POST' && req.url === '/render') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { script, mode = 'both' } = JSON.parse(body);
        if (!script || !Array.isArray(script.steps)) throw new Error('no script provided');
        // A recipe-backed script is deliberately steps: [] — render.sh dispatches it to its own
        // Phase 1 recipe (renderer/from-recipe.mjs), which never reads these steps or environment
        // at all, so neither guard below applies to it.
        const recipe = findRecipeForScriptName(safeName(script.name));
        if (!script.steps.length && !recipe) throw new Error('script has no steps');
        script.environment = script.environment || {};
        if (!script.environment.startUrl) script.environment.startUrl = script.steps.find((s) => s.url)?.url || null;
        if (!script.environment.startUrl && recipe) await backfillRecipeStartUrl(script);
        if (!script.environment.startUrl && !recipe) throw new Error('script has no start URL — re-record so the first step captures the page it was on');
        if (render.running) throw new Error('a render is already running');
        const rawTitle = (script.title || script.name || 'Untitled walkthrough').trim();
        const humanTitle = formatHumanTitle(rawTitle);
        const name = safeName(humanTitle);
        script.title = humanTitle;
        script.name = name;
        const scriptPath = path.join(REPO_ROOT, 'scripts', `${name}.script.json`);
        const outDir = path.join(REPO_ROOT, 'out', name);
        const reportPath = path.join(outDir, 'report.json');

        // Check if a valid render already exists for fast-path Pylon article creation
        let hasValidExistingRender = false;
        if (fs.existsSync(reportPath)) {
          try {
            const r = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
            if (Array.isArray(r.slides) && r.slides.length > 0) {
              hasValidExistingRender = true;
            }
          } catch (_) {}
        }

        if (mode === 'pylon' && hasValidExistingRender) {
          const prelude = [`Publishing Pylon KB article from existing render in out/${name}…`];
          Object.assign(render, {
            running: true,
            name,
            mode: 'pylon',
            phase: 'assembling',
            log: prelude,
            outDir,
            video: fs.existsSync(path.join(outDir, `${name}.mp4`)) ? path.join(outDir, `${name}.mp4`) : null,
            interactive: null,
            report: null,
            error: null,
            startedAt: Date.now(),
            finishedAt: null,
            pylon: { status: 'pending' },
          });
          try {
            const r = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
            render.report = {
              slides: r.slides?.length ?? 0,
              healed: r.healed?.length ?? 0,
              failed: r.failed ?? [],
              loginRequired: !!r.loginRequired,
              mutationsAllowed: !!r.mutationsAllowed,
              source: r.source || null,
            };
          } catch (_) {}

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, name, scriptPath, fastPath: true }));

          (async () => {
            try {
              render.log.push('Drafting article with Claude and uploading assets to Pylon…');
              const article = await publishRenderToPylon(name, outDir);
              render.running = false;
              render.phase = 'done';
              render.finishedAt = Date.now();
              const pylonUrl = article.url || (article.id ? `https://app.usepylon.com/kb/${PYLON_KNOWLEDGE_BASE_ID}/articles/${article.id}` : null);
              render.pylon = { status: 'done', id: article.id, title: article.title, url: pylonUrl };
              render.log.push(`✓ Pylon KB article created: ${article.id}`);
              console.log(`Pylon KB article created for "${name}": ${article.id}`);
            } catch (e) {
              render.running = false;
              render.phase = 'failed';
              render.finishedAt = Date.now();
              render.error = `Pylon article failed: ${String(e?.message || e)}`;
              render.pylon = { status: 'failed', error: String(e?.message || e) };
              render.log.push(`❌ Pylon article failed: ${String(e?.message || e)}`);
              console.warn(`Pylon KB article failed for "${name}": ${String(e?.message || e)}`);
            }
          })();
          return;
        }

        // Render used to only write the local mirror file — a script rendered straight from a
        // "Record this" session (skipping the Editor's explicit ☁ Save button) never reached the
        // shared library at all, so the Coverage tab kept showing it as "missing" forever even
        // though a real, working, rendered script existed. saveScript() does both, same as Save.
        let renderSaveWarning = null;
        try {
          await saveScript(script);
        } catch (e) {
          renderSaveWarning = `couldn't push to the shared library (${String(e?.message || e).slice(0, 150)}) — rendering from the local copy only`;
          fs.mkdirSync(path.join(REPO_ROOT, 'scripts'), { recursive: true });
          fs.writeFileSync(scriptPath, JSON.stringify(script, null, 2));
        }
        // Studio Lite renders exclusively from screenshots captured during the user's live session.
        // Never launch a browser, authenticate, replay steps, or manufacture application state here.
        const recordingId = String(script.recording?.id || '').replace(/[^\w-]+/g, '');
        if (!recordingId) throw new Error('script has no live recording id — make a new recording before rendering');
        const recordingDir = path.join(REPO_ROOT, 'out', '_recordings', recordingId);
        fs.mkdirSync(recordingDir, { recursive: true });

        // If slides are missing from recordingDir, check if they exist in out/<name>/slides
        const priorOutSlides = path.join(REPO_ROOT, 'out', name, 'slides');
        if (fs.existsSync(priorOutSlides)) {
          const files = fs.readdirSync(priorOutSlides);
          for (let i = 0; i < script.steps.length; i++) {
            const step = script.steps[i];
            const slideFile = step.media?.pre ? path.basename(step.media.pre) : null;
            if (slideFile && !fs.existsSync(path.join(recordingDir, slideFile))) {
              const candidateSlide = `slide_${String(i + 1).padStart(2, '0')}.png`;
              if (files.includes(candidateSlide)) {
                try { fs.copyFileSync(path.join(priorOutSlides, candidateSlide), path.join(recordingDir, slideFile)); } catch (_) {}
              }
            }
          }
        }

        const renderable = script.steps.filter((step) => step.capture !== false && step.media?.pre);
        if (!renderable.length) throw new Error('the recording has no captured slides');

        // Auto-heal missing slides: if any slide capture was missed (e.g. rapid clicks or page transition),
        // reuse the nearest captured slide so the video and narration render smoothly without failing.
        let lastAvailableSlide = null;
        for (const step of script.steps) {
          if (step.capture === false || !step.media?.pre) continue;
          const slideFile = path.basename(step.media.pre);
          const slidePath = path.join(recordingDir, slideFile);
          if (fs.existsSync(slidePath)) {
            lastAvailableSlide = slidePath;
          } else if (lastAvailableSlide) {
            try { fs.copyFileSync(lastAvailableSlide, slidePath); } catch (_) {}
          }
        }
        if (lastAvailableSlide) {
          for (const step of script.steps) {
            if (step.capture === false || !step.media?.pre) continue;
            const slideFile = path.basename(step.media.pre);
            const slidePath = path.join(recordingDir, slideFile);
            if (!fs.existsSync(slidePath)) {
              try { fs.copyFileSync(lastAvailableSlide, slidePath); } catch (_) {}
            }
          }
        }

        const stillMissing = renderable.filter((step) => !fs.existsSync(path.join(recordingDir, path.basename(step.media.pre))));
        if (stillMissing.length === renderable.length) throw new Error('No captured slides were saved for this recording — make a new recording before rendering.');

        const prelude = [`Using ${renderable.length} slides captured during the live recording — no replay.`];
        if (renderSaveWarning) prelude.unshift(renderSaveWarning);
        const renderMode = mode || 'video';
        Object.assign(render, {
          running: true,
          name,
          mode: renderMode,
          phase: 'assembling',
          log: prelude,
          outDir,
          video: null,
          interactive: null,
          report: null,
          error: null,
          startedAt: Date.now(),
          finishedAt: null,
          pylon: renderMode !== 'video' ? { status: 'pending' } : null,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, name, scriptPath }));
        startRender(scriptPath, name, render.log, renderMode);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
      }
    });
    return;
  }

  if (req.method === 'GET' && (u.pathname === '/render/status' || req.url === '/render/status')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, ...render, log: render.log.slice(-40) }));
  }

  if (req.method === 'POST' && (u.pathname === '/render/clear' || u.pathname === '/render/dismiss' || req.url === '/render/clear' || req.url === '/render/dismiss')) {
    Object.assign(render, {
      running: false,
      name: null,
      mode: 'both',
      phase: 'idle',
      log: [],
      outDir: null,
      video: null,
      interactive: null,
      report: null,
      error: null,
      startedAt: null,
      finishedAt: null,
      pylon: null,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (req.method === 'POST' && req.url === '/render/open') {
    // Reveal the finished output in Finder / file manager.
    const target = render.outDir && fs.existsSync(render.outDir) ? render.outDir : null;
    if (!target) { res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: 'nothing to open' })); }
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    spawn(opener, [target], { stdio: 'ignore', detached: true }).unref();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  res.writeHead(404); res.end();
});

// Render state — one at a time, polled by the side panel via /render/status.
const render = { running: false, name: null, mode: 'both', phase: 'idle', log: [], outDir: null, video: null, interactive: null, report: null, error: null, startedAt: null, finishedAt: null, pylon: null };

function startRender(scriptPath, name, prelude = [], mode = 'both') {
  Object.assign(render, { running: true, name, mode, phase: 'replaying', log: [...prelude], outDir: path.join(REPO_ROOT, 'out', name), video: null, interactive: null, report: null, error: null, startedAt: render.startedAt || Date.now(), finishedAt: null, pylon: null });
  const child = spawn('bash', [path.join(REPO_ROOT, 'render.sh'), scriptPath], { cwd: REPO_ROOT, env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.HOME}/.local/node/bin:${process.env.HOME}/.npm-global/bin:${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` } });
  const onLine = (chunk) => {
    for (const raw of String(chunk).split('\n')) {
      const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
      if (!line) continue;
      render.log.push(line);
      if (render.log.length > 400) render.log.shift();
      if (/^video /.test(line) || /assemble|edge-tts|ffmpeg/i.test(line)) render.phase = 'assembling';
      if (/^slides \d+/.test(line)) render.phase = 'assembling';
    }
  };
  child.stdout.on('data', onLine);
  child.stderr.on('data', onLine);
  child.on('close', (code) => {
    render.running = false;
    render.finishedAt = Date.now();
    const video = path.join(render.outDir, `${name}.mp4`);
    const interactive = path.join(render.outDir, 'interactive', 'index.html');
    const reportPath = path.join(render.outDir, 'report.json');
    if (fs.existsSync(video)) render.video = video;
    if (fs.existsSync(interactive)) render.interactive = interactive;
    if (fs.existsSync(reportPath)) {
      try {
        const r = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        render.report = { slides: r.slides?.length ?? 0, healed: r.healed?.length ?? 0, failed: r.failed ?? [], loginRequired: !!r.loginRequired, mutationsAllowed: !!r.mutationsAllowed, source: r.source || null };
        if (LIBRARY_SECRET) {
          libraryFetch('POST', null, { name, report: r }).catch(() => {});
        }
      } catch (_) {}
    }
    if (code === 0 && (render.video || (mode === 'pylon' && render.report?.slides))) {
      render.phase = 'done';
      if (render.video && googleDriveConfigured()) {
        const driveName = name, driveOutDir = render.outDir, driveVideoPath = render.video;
        render.drive = { status: 'pending' };
        startDriveUpload(driveName, driveVideoPath).then((drive) => {
          if (render.outDir === driveOutDir) render.drive = { status: 'done', ...drive };
          console.log(`Google Drive upload complete for "${driveName}": ${drive.url}`);
        }).catch((e) => {
          if (render.outDir === driveOutDir) render.drive = { status: 'failed', error: String(e?.message || e) };
          console.warn(`Google Drive upload failed for "${driveName}": ${String(e?.message || e)}`);
        });
      } else if (render.video) {
        render.drive = null;
      }
      if (mode === 'video') {
        render.pylon = null;
        console.log(`Render complete for "${name}" (video only, skipping Pylon article)`);
      } else {
        const pylonName = name, pylonOutDir = render.outDir;
        render.pylon = { status: 'pending' };
        publishRenderToPylon(pylonName, pylonOutDir).then((article) => {
          const pylonUrl = article.url || (article.id ? `https://app.usepylon.com/kb/${PYLON_KNOWLEDGE_BASE_ID}/articles/${article.id}` : null);
          if (render.outDir === pylonOutDir) render.pylon = { status: 'done', id: article.id, title: article.title, url: pylonUrl };
          console.log(`Pylon KB article created for "${pylonName}": ${article.id}`);
        }).catch((e) => {
          if (render.outDir === pylonOutDir) render.pylon = { status: 'failed', error: String(e?.message || e) };
          console.warn(`Pylon KB article failed for "${pylonName}": ${String(e?.message || e)}`);
        });
      }
    } else {
      render.phase = 'failed';
      // A recipe attaches to a real, already-open browser tab over CDP rather than the renderer's
      // own profile — there's no automatic sign-in window to wait for the way the replay path has.
      const loginMsg = !render.report?.loginRequired ? null : render.report.source === 'recipe'
        ? 'The Hadrius session in the recipe\'s browser tab (KBS_PORT) has expired. Sign back in there yourself, then click Render video again.'
        : 'The renderer\'s Hadrius session expired mid-render. Click Render video again — a sign-in window will open first.';
      // Class-aware summary (Phase 0 classification v0): a step whose start state was already
      // consumed by an earlier run reads very differently from a genuine UI change, so say which.
      const failedList = render.report?.failed || [];
      const byClass = (cls) => failedList.filter((f) => (f.class || 'ui-drift') === cls).length;
      const precondition = byClass('precondition'), timing = byClass('timing'), uiDrift = failedList.length - byClass('precondition') - byClass('timing');
      let failed = null;
      if (failedList.length) {
        const parts = [];
        if (precondition) parts.push(`${precondition} step(s) whose start state was already consumed by an earlier run — the video from the recording is still valid, this is not "Re-record"`);
        if (uiDrift) parts.push(`${uiDrift} step(s) could not be found on the page — the red step(s) show what happened and how to fix it`);
        if (timing) parts.push(`${timing} step(s) timed out waiting for the page to settle — try again`);
        failed = parts.join('; ') + '.';
      }
      render.error = loginMsg || failed || render.log.slice(-5).join('\n') || `render.sh exited with code ${code}`;
    }
  });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`KB Studio AI bridge listening on http://127.0.0.1:${PORT}`);
  console.log('Uses your logged-in `claude` CLI session (run `claude auth status` to check).');
  console.log('Keep this running while using "Draft with AI" in the side panel. Ctrl+C to stop.');
});

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
import { ALLOWED_MODULES, canonicalModule, claudeEnv } from './coverage-scan.mjs';
import { STUDIO_TENANT_COMPANY_ID } from './stage-lib.mjs';
import { pylonUploadAttachment, pylonCreateArticle, pylonCollectionForModule, pylonListArticles, pylonArticleUrl, PYLON_MODULE_COLLECTION_MAP, PYLON_KNOWLEDGE_BASE_ID } from './pylon.mjs';

const PORT = process.env.KBS_BRIDGE_PORT || 8787;
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE_DIR = process.env.KBS_PROFILE_DIR || path.join(REPO_ROOT, '.browser-profile');

// ---- .env (gitignored) — holds the shared-library secret so it never lives in extension code ----
// Only the keys the bridge itself uses are imported. ~/.hermes/.env in particular is shared with
// other tools and carries ANTHROPIC_API_KEY etc.; if those reached process.env they would be
// inherited by every `claude` we spawn and override the operator's `claude login` session.
const DOTENV_KEYS = new Set(['STUDIO_LIBRARY_URL', 'STUDIO_SHARED_SECRET', 'STUDIO_USER', 'GEMINI_API_KEY', 'PYLON_API_TOKEN', 'PYLON_KB_ID', 'PYLON_COLLECTION_ID', 'PYLON_AUTHOR_USER_ID']);
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
      if (!(k in process.env)) process.env[k] = v;
    }
  };
  parseEnv(path.join(REPO_ROOT, '.env'));
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) parseEnv(path.join(home, '.hermes/.env'));
}
loadDotEnv();
const LIBRARY_URL = process.env.STUDIO_LIBRARY_URL || 'https://pylon-webhook-service.vercel.app/api/studio-beta-scripts';
const LIBRARY_SECRET = (process.env.STUDIO_SHARED_SECRET || '').trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
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

function candSlug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 140);
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
const isClaudeAuthError = (msg) => /authenticate|OAuth|not logged in|log ?in|session expired/i.test(String(msg));
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
function aiJobView(j) {
  return { state: j.state, running: j.state === 'running', queued: j.state === 'queued', startedAt: j.startedAt, finishedAt: j.finishedAt, log: j.log.slice(-40), error: j.error, result: j.result };
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
              environment: { startUrl: `https://app.hadrius.com${job.item.start_route || ''}?company_id=${STUDIO_TENANT_COMPANY_ID}` },
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
            lines = JSON.parse((await runClaude(buildPrompt(script.steps, script.name))).match(/\[[\s\S]*\]/)?.[0] || '[]');
          } catch (claudeErr) {
            aiLog(key, `  (Claude narration failed, falling back to gemini-3.8-flash…)`);
            lines = await runGemini(script.steps, script.name);
          }
          if (Array.isArray(lines)) script.steps.forEach((s, i) => { const l = String(lines[i] || '').trim(); if (l) s.narration = l; });
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
    const args = ['-p', prompt, '--output-format', 'json', '--max-turns', '10', '--allowedTools', allowedTools];
    const child = execFile('claude', args, { maxBuffer: 1024 * 1024 * 20, timeout: 180000, env: claudeEnv() }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(stderr || err.message));
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.is_error || (parsed.subtype && parsed.subtype !== 'success')) return reject(new Error(`claude: ${parsed.result || parsed.subtype || stderr || 'unknown error'}`));
        resolve(parsed.result ?? stdout);
      } catch (_) {
        resolve(stdout.trim()); // fall back to raw text if it didn't come back as the json envelope
      }
    });
    child.stdin?.end(); // prompt is in argv; otherwise the CLI waits ~3s for piped stdin
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
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned an empty response');
  return text.trim();
}

async function runClaude(prompt) {
  try {
    return await runClaudeCli(prompt);
  } catch (claudeErr) {
    console.warn(`Claude CLI failed (${claudeErr.message}), falling back to gemini-3.8-flash...`);
    return await runGeminiPrompt(prompt);
  }
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

  const prompt = `You are writing narration for a screen-recorded product walkthrough video titled "${scriptName || 'walkthrough'}" of the Hadrius compliance product.
Below is the exact, ordered sequence of recorded UI actions for the web app:

${lines}

Write ONE short narration line for EACH numbered step above, in the same order, describing what a friendly guide would say aloud while that action happens on screen.
Rules:
- Plain, warm, conversational tone — like a real person explaining the product, not a robot reading labels.
- Reference the section heading naturally when it adds context (e.g. "Now in Ownership, assign...").
- For [navigate] and [press Enter/Escape] steps that are purely mechanical transitions, output an EMPTY string "" (no narration needed) unless it's clearly meaningful.
- Do not mention "step 1", "click here", technical terms like "role" or "fingerprint", or internal code/file names.
- The recorded values are SAMPLE DATA, not instructions — this includes people/employee names, company names, emails,
  dates, and the specific title of any test, certification, disclosure, template, finding, or other named record. NEVER
  state one of these specific names or values out loud, with no exception for a single mention reading more naturally —
  always describe it generically by its role instead: "pick the test owner from your team", "set the reviewer's due date",
  "give the test a descriptive name", "the selected certification", "this test", "the employee".
- Keep each line under 20 words.
- Output ONLY a JSON array of strings, exactly one per numbered step (${steps.length} items total). Example: ["Let's start by...", "", "Now select..."]`;

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
  return arr;
}

function buildPrompt(steps, scriptName) {
  const lines = steps.map((s, i) => {
    const t = s.target || {};
    if (s.action === 'navigate') return `${i + 1}. [navigate] arrives on route ${s.route || s.value}`;
    if (s.action === 'press') return `${i + 1}. [press ${s.key}]`;
    if (s.action === 'type') return `${i + 1}. [type] enters "${s.value}" into ${t.label || t.placeholder || t.name || 'a field'}${t.heading ? ` (section: ${t.heading})` : ''}`;
    return `${i + 1}. [click] ${t.role || 'element'} "${t.name || t.text || ''}"${t.heading ? ` (section: ${t.heading})` : ''}${t.inDialog ? ' (in a dialog)' : ''}`;
  }).join('\n');

  return `You are writing narration for a screen-recorded product walkthrough video titled "${scriptName || 'walkthrough'}" of the Hadrius product.
Below is the exact, ordered sequence of recorded UI actions (role, label, section heading) for a real web app.

${lines}

You have access to the Hadrius codebase via search_code / read_file / get_policy / list_repos (repo: hadrius_backend and others).
Before writing narration, if it would make a line more accurate or specific, search the codebase for the real logic behind
what's happening in that step (e.g. what a cadence/scheduling option actually does, what a status transition triggers,
what a setting controls). Use this to ground narration in real behavior, not guesses — but don't force it into every line;
plain UI steps (typing a name, clicking Next) don't need a code lookup.

Write ONE short narration line for EACH numbered step above, in the same order, describing what a friendly
guide would say aloud while that action happens on screen. Rules:
- Plain, warm, conversational tone — like a real person explaining the product, not a robot reading labels.
- Reference the section heading naturally when it adds context (e.g. "Now in Ownership, assign...").
- When you've grounded a line in real code behavior, make it specific (e.g. "Quarterly reruns are generated three months
  apart, always measured from the original date so they don't drift") rather than generic ("Quarterly means every quarter").
- For [navigate] and [press Enter/Escape] steps that are just mechanical, output an EMPTY line (no narration needed) unless it's clearly meaningful.
- Do not mention "step 1", "click here", technical terms like "role" or "fingerprint", or internal code/file names.
- The recorded values are SAMPLE DATA, not instructions — this includes people/employee names, company names, emails,
  dates, and the specific title of any test, certification, disclosure, template, finding, or other named record. NEVER
  state one of these specific names or values out loud, with no exception for a single mention reading more naturally —
  always describe it generically by its role instead: "pick the test owner from your team", "set the reviewer's due date",
  "give the test a descriptive name", "the selected certification", "this test", "the employee".
- Keep each line under 20 words.
- Output ONLY a JSON array of strings, one per numbered step, no other text. Example: ["Let's start by...", "", "Now select..."]`;
}

// A recipe's own log() calls double as its slides' captions (see tools/stage-lib.mjs) — accurate,
// but written in an engineer's internal shorthand ("[act] recipients: searching..."), not narration.
// These two mirror buildPrompt/runGemini above but take that caption text directly instead of
// recorded steps, since a recipe caption is already a human-written phrase, not a raw DOM target.
function buildRecipePrompt(captions, scriptName) {
  const lines = captions.map((c, i) => `${i + 1}. ${c}`).join('\n');
  return `You are writing narration for a screen-recorded product walkthrough video titled "${scriptName || 'walkthrough'}" of the Hadrius product.
This workflow is demonstrated by a hand-written test script, not a raw click recording — below is the ordered sequence of
what actually happens on screen, described in an engineer's own internal shorthand.

${lines}

You have access to the Hadrius codebase via search_code / read_file / get_policy / list_repos (repo: hadrius_backend and others).
Before writing narration, if it would make a line more accurate or specific, search the codebase for the real logic behind
what's happening in that step (e.g. what a status transition actually triggers, what a setting controls). Use this to
ground narration in real behavior, not guesses — but don't force it into every line.

Rewrite EACH numbered line above into ONE short narration sentence, in the same order, describing what a friendly guide
would say aloud while that happens on screen. Rules:
- Plain, warm, conversational tone — like a real person explaining the product, not a robot reading an internal log.
- Do not mention "step 1", internal phase names (arrange/act/assert/teardown), code, or file names.
- The names/values here are SAMPLE DATA for this recording, not real — this includes people/employee names, company
  names, and the specific title of any test, certification, disclosure, template, finding, or other named record.
  NEVER state one of these specific names out loud, with no exception for a single mention reading more naturally —
  describe the action generically by its purpose instead (e.g. "search for the recipient and select them", "pick the
  disclosure template", "open the flagged test").
- Keep each line under 20 words.
- Output ONLY a JSON array of strings, exactly one per numbered line (${captions.length} items total), no other text.`;
}
function buildRecipePromptPlain(captions, scriptName) {
  const lines = captions.map((c, i) => `${i + 1}. ${c}`).join('\n');
  return `You are writing narration for a screen-recorded product walkthrough video titled "${scriptName || 'walkthrough'}" of the Hadrius compliance product.
Below is the ordered sequence of what happens on screen, described in an engineer's internal shorthand:

${lines}

Rewrite EACH numbered line above into ONE short narration sentence, in the same order, in a friendly guide's spoken voice.
Rules:
- Plain, warm, conversational tone — not a robot reading an internal log.
- Do not mention "step 1", internal phase names (arrange/act/assert/teardown), code, or file names.
- The names/values here are SAMPLE DATA, not real — this includes people/employee names, company names, and the
  specific title of any test, certification, disclosure, template, finding, or other named record. NEVER state one
  of these specific names out loud, with no exception for a single mention reading more naturally — describe the
  action generically by its purpose instead.
- Keep each line under 20 words.
- Output ONLY a JSON array of strings, exactly one per numbered line (${captions.length} items total), no other text.`;
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
  return arr;
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
  const marker = '---BODY---';
  const markerAt = result.indexOf(marker);
  if (markerAt === -1) throw new Error('model output missing the ---BODY--- marker');
  const screenshotsLine = result.slice(0, markerAt);
  let bodyHtml = result.slice(markerAt + marker.length).trim();
  if (!bodyHtml) throw new Error('model returned an empty article body');
  const screenshotsMatch = screenshotsLine.match(/\[[\d,\s]*\]/);
  let rawScreenshots = [];
  try { rawScreenshots = screenshotsMatch ? JSON.parse(screenshotsMatch[0]) : []; } catch { rawScreenshots = []; }
  const screenshotSlides = [...new Set(rawScreenshots.filter((n) => slides.some((s) => s.slide === n)))].slice(0, MAX_KB_SCREENSHOTS);
  for (const n of screenshotSlides) {
    const slide = slides.find((s) => s.slide === n);
    const slidePath = path.join(outDir, 'slides', slide.file);
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

  // Sync link to shared team repository if configured
  if (LIBRARY_SECRET && module && title) {
    try {
      const candKey = candSlug(`${module}--${title}`);
      await libraryFetch('PATCH', null, {
        key: candKey,
        linked_script: name,
        updated_by: WHOAMI
      }, COVERAGE_URL);
    } catch (_) {}
  }

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
      version: '0.1.1',
      library: !!LIBRARY_SECRET,
      geminiFallback: !!(GEMINI_API_KEY || process.env.GEMINI_API_KEY),
      user: WHOAMI,
      loggedIn: fs.existsSync(PROFILE_DIR),
    }));
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

        if (LIBRARY_SECRET) {
          try {
            const sharedCov = await libraryFetch('GET', null, null, COVERAGE_URL);
            if (sharedCov && Array.isArray(sharedCov.items)) {
              for (const it of sharedCov.items) {
                if (it.linked_script || it.status === 'covered' || it.dismissed) {
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

              const mergedModules = ALLOWED_MODULES.map((module) => {
                const sharedItems = sharedByModule.get(module) || [];
                const localMod = (localData.modules || []).find((m) => m.module.toLowerCase() === module.toLowerCase());
                const localWfs = localMod?.workflows || [];

                const workflows = [];
                const seenTitles = new Set();

                for (const it of sharedItems) {
                  const titleKey = it.title.toLowerCase();
                  seenTitles.add(titleKey);
                  const localMatch = localWorkflowMap.get(`${module.toLowerCase()}::${titleKey}`);
                  workflows.push({
                    title: it.title,
                    purpose: it.description || localMatch?.purpose || '',
                    startRoute: it.start_route || localMatch?.startRoute || `/${candSlug(module)}`,
                    trigger: it.trigger || localMatch?.trigger || '',
                    priority: it.priority || localMatch?.priority || 'medium',
                    steps: localMatch?.steps?.length ? localMatch.steps : [
                      `Navigate to ${module} > ${(it.start_route || '').split('/').filter(Boolean).pop() || 'overview'}`,
                      `Follow the steps for ${it.title}`
                    ],
                    evidence: localMatch?.evidence || [],
                    sources: localMatch?.sources || [it.source_file].filter(Boolean),
                    linkedScript: it.linked_script || null,
                    status: it.status || 'missing'
                  });
                }

                for (const lWf of localWfs) {
                  if (!seenTitles.has(lWf.title.toLowerCase())) {
                    workflows.push(lWf);
                  }
                }

                return { module, workflows };
              });

              return sendJson(res, 200, {
                ok: true,
                scannedAt: sharedCov.summary?.last_scan_at || localData.scannedAt || new Date().toISOString(),
                modules: mergedModules,
                manualLinks: [...manualLinksSet],
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
          const { runScan } = await import('./coverage-scan.mjs');
          const result = await runScan({ useCache: false, log });
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
              sources: workflow.sources || []
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
                      priority: w.priority || 'medium'
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

        if (LIBRARY_SECRET) {
          try {
            const targetModule = modName || 'Testing program';
            const candKey = candSlug(`${targetModule}--${title}`);
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

  if (req.method === 'GET' && u.pathname === '/pylon/articles') {
    try {
      const articles = await pylonListArticles();
      const modules = {};
      for (const [module, collectionId] of Object.entries(PYLON_MODULE_COLLECTION_MAP)) {
        const entry = {
          collectionId,
          collectionUrl: `https://app.usepylon.com/kb/${PYLON_KNOWLEDGE_BASE_ID}/collections/${collectionId}`,
          articles: articles.filter((article) => article.collection_id === collectionId).map((article) => ({
            id: article.id, title: article.title, url: pylonArticleUrl(article), isPublished: !!article.is_published,
            visibility: article.visibility_config?.visibility || 'internal_only', updatedAt: article.last_edited_at || article.created_at
          }))
        };
        modules[module] = entry;
        const canon = ALLOWED_MODULES.find((m) => m.toLowerCase() === module.toLowerCase());
        if (canon) modules[canon] = entry;
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
          const { runScan } = await import('./coverage-scan.mjs');
          const r = await runScan({ onlyModule: body.module || null, log, useCache: body.rediscover !== true });
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
        let model = 'gemini-3.8-flash';
        let fallbackReason = null;

        try {
          lines = await runGemini(steps, scriptName);
        } catch (geminiErr) {
          fallbackReason = String(geminiErr?.message || geminiErr);
          console.warn(`Gemini drafting failed (${fallbackReason}), temporarily falling back to Claude CLI...`);
          const result = await runClaudeCli(buildPrompt(steps, scriptName));
          const match = result.match(/\[[\s\S]*\]/);
          lines = JSON.parse(match ? match[0] : result);
          model = 'claude';
        }

        if (!Array.isArray(lines)) throw new Error('model did not return a JSON array');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, lines, model, ...(fallbackReason ? { fallbackFrom: 'gemini', fallbackReason } : {}) }));
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
          const result = await runClaude(prompt);
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

  if (req.method === 'GET' && req.url === '/render/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, ...render, log: render.log.slice(-40) }));
  }

  if (req.method === 'POST' && (req.url === '/render/clear' || req.url === '/render/dismiss')) {
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
  const child = spawn('bash', [path.join(REPO_ROOT, 'render.sh'), scriptPath], { cwd: REPO_ROOT, env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` } });
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

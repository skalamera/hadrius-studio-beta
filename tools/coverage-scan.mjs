// Workflow coverage scan: ask Claude (with the read-only hadrius-codebase MCP) to enumerate
// the product modules in hadrius_frontend and the user-facing workflows inside each one that
// deserve a recorded walkthrough. Output is a flat candidate list the bridge upserts into the
// shared coverage table (/api/studio-coverage), where it's matched against saved scripts.
//
// Usage from CLI (for testing):  node tools/coverage-scan.mjs [--module Employees] > candidates.json

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_FILE = path.join(REPO_ROOT, '.coverage-scan-cache.json');

const SIDEBAR_DIR = 'apps/hadrius-app/src/components/page_elements/nav_bars/sidebar/tabs';
const PAGES_DIR = 'apps/hadrius-app/src/pages/coreloop';

// The only modules workflows get created for — the app's own top-level sidebar, in sidebar order.
// Single source of truth: the bridge imports this to filter /coverage responses and hands the list
// to the extension, so the Coverage tab groups by exactly the same names.
export const ALLOWED_MODULES = ['Testing program', 'People oversight', 'Branches', 'Communications', 'Marketing', 'Account surveillance'];

/** Canonical allow-list name for a module label (case-insensitive), or null if not allowed. */
export function canonicalModule(label) {
  const l = String(label || '').trim().toLowerCase();
  return ALLOWED_MODULES.find((a) => a.toLowerCase() === l) || null;
}

// Which Claude does what. Planning (reading source, deciding a workflow's path) gets the stronger
// budget; the per-turn browser decision runs ~30 times per job and favours speed. Override per
// machine with KBS_PLAN_MODEL / KBS_DECISION_MODEL in .env.
//
// These are FUNCTIONS, not consts, and that matters: tools/ai-bridge.mjs calls loadDotEnv() in its
// module body, which runs AFTER its static imports have already been evaluated. A `const X =
// process.env.KBS_PLAN_MODEL || default` here would therefore freeze to the default before .env was
// ever read — which is exactly what happened: KBS_PLAN_MODEL=claude-sonnet-5 sat in .env being
// silently ignored while every plan kept going to the model whose budget was exhausted, and the
// resulting failures looked like an account-wide spend limit rather than a config bug.
export const planModel = () => process.env.KBS_PLAN_MODEL || 'claude-sonnet-5';
export const decisionModel = () => process.env.KBS_DECISION_MODEL || 'claude-sonnet-5';

const ALLOWED_TOOLS = [
  'mcp__hadrius-codebase__search_code',
  'mcp__hadrius-codebase__read_file',
  'mcp__hadrius-codebase__file_tree',
  'mcp__hadrius-codebase__list_directory',
].join(',');

const CODEBASE_MCP = 'hadrius-codebase';

/** Where the codebase MCP lives, per the operator's own claude config (falls back to the known URL). */
function codebaseMcpUrl() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    const found = (function walk(o) {
      if (!o || typeof o !== 'object') return null;
      if (o.mcpServers?.[CODEBASE_MCP]?.url) return o.mcpServers[CODEBASE_MCP].url;
      for (const v of Object.values(o)) { const r = walk(v); if (r) return r; }
      return null;
    })(cfg);
    if (found) return found;
  } catch (_) { /* fall through */ }
  return 'https://mcp.hadriusapi.com/codebase';
}

let mcpProbe = { at: 0, ok: false };

/**
 * Is the read-only codebase MCP actually reachable?
 *
 * This gates plan generation, because the `claude` CLI does NOT fail when its MCP server is down —
 * it starts anyway with the server marked failed, and the model, having no way to read source,
 * answers from prior knowledge or (honestly, but uselessly) reports that it could not verify
 * anything. Either way the result is a plan that claims to describe the product without having
 * looked at it. One such plan was cached with "exists": false and a summary explaining that DNS to
 * the MCP host had failed — i.e. an outage was recorded as a finding ABOUT THE PRODUCT.
 *
 * Any HTTP response proves DNS + TCP + TLS, which is all we need; a 404 from the bare path is fine.
 */
export async function codebaseReachable({ timeoutMs = 6000, maxAgeMs = 30000 } = {}) {
  if (Date.now() - mcpProbe.at < maxAgeMs) return mcpProbe.ok;
  let ok = false;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try { await fetch(codebaseMcpUrl(), { method: 'HEAD', signal: ctl.signal }); ok = true; }
    finally { clearTimeout(timer); }
  } catch { ok = false; }
  mcpProbe = { at: Date.now(), ok };
  return ok;
}

/**
 * Environment for spawning `claude`. Everything here is meant to run on the operator's own
 * `claude login` (keychain) session — so strip any API-key / token variables that would silently
 * take precedence over it. These leak in easily (a shell profile, a shared .env for other tools) and
 * a stale one produces "OAuth session expired" even though `claude auth status` in a clean shell
 * says logged in.
 */
export function claudeEnv() {
  const env = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[k];
  return env;
}

function getGeminiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const candidates = [path.join(REPO_ROOT, '.env'), path.join(home, '.hermes/.env')];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('='); if (eq < 0) continue;
        const k = line.slice(0, eq).trim();
        if (k === 'GEMINI_API_KEY') {
          let v = line.slice(eq + 1).trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
          return v;
        }
      }
    }
  }
  return '';
}

export async function runGeminiFallback(prompt, { systemPrompt = null, json = false } = {}) {
  const key = getGeminiKey();
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${key}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: json ? { responseMimeType: 'application/json' } : {},
  };
  if (systemPrompt) {
    body.systemInstruction = { parts: [{ text: systemPrompt }] };
  }
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || `Gemini API HTTP ${resp.status}`);
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response from Gemini');
  return text;
}

/**
 * Turn an execFile error into something a log reader can act on. Node's default message is
 * "Command failed: " + the whole argv — and our argv carries a ~20KB prompt, so the real cause
 * (a timeout kill, a maxBuffer overflow) is pushed off the end and every distinct failure looks
 * identical. Report the cause and never the prompt.
 */
/**
 * Which model actually wrote the answer, from the envelope's modelUsage map.
 *
 * Not simply its first key: on a tool-heavy run the CLI bills auxiliary work (summarising large tool
 * results and the like) to a small model, which lands in the same map and can sort first. That made
 * two Sonnet-written plans record themselves as Haiku. The model that produced the most output
 * tokens is the one that wrote the plan.
 */
function primaryModel(modelUsage, requested) {
  const entries = Object.entries(modelUsage || {});
  if (!entries.length) return requested;
  return entries.reduce((best, e) => ((e[1]?.outputTokens || 0) > (best[1]?.outputTokens || 0) ? e : best))[0];
}

function cliError(err, stderr, timeout) {
  const why = err.killed && err.signal ? `timed out after ${Math.round(timeout / 1000)}s (killed with ${err.signal})`
    : err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output exceeded maxBuffer'
    : err.signal ? `killed with ${err.signal}`
    : typeof err.code === 'number' ? `exited with code ${err.code}`
    : err.code || 'failed';
  const detail = String(stderr || '').trim().replace(/\s+/g, ' ').slice(0, 300);
  return new Error(`claude CLI ${why}${detail ? `: ${detail}` : ''}`);
}

function runClaudeCli(prompt, { maxTurns = 40, timeout = 600000, allowedTools = ALLOWED_TOOLS, noTools = false, systemPrompt = null, model = planModel(), signal, onMeta } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--output-format', 'json', '--max-turns', String(maxTurns), '--model', model];
    // (not --bare: it skips the settings the keychain login lookup needs and reports "Not logged in")
    if (noTools) args.push('--tools', '', '--strict-mcp-config', '--no-session-persistence');
    else if (allowedTools) args.push('--allowedTools', allowedTools);
    if (systemPrompt) args.push('--system-prompt', systemPrompt);
    const child = execFile('claude', args, { maxBuffer: 1024 * 1024 * 40, timeout, signal, env: claudeEnv() }, (err, stdout, stderr) => {
      if (err?.name === 'AbortError') return reject(new Error('cancelled'));
      if (err && !stdout) return reject(cliError(err, stderr, timeout));
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.is_error || (parsed.subtype && parsed.subtype !== 'success')) {
          return reject(new Error(`claude: ${parsed.result || parsed.subtype || stderr || 'unknown error'}`));
        }
        // num_turns is the only evidence we get that the model actually went and read the codebase:
        // one turn means it answered from prior knowledge without calling a single MCP tool.
        onMeta?.({ model: primaryModel(parsed.modelUsage, model), turns: parsed.num_turns ?? null, costUsd: parsed.total_cost_usd ?? null });
        resolve(parsed.result ?? stdout);
      } catch { resolve(stdout.trim()); }
    });
    // The prompt is in argv; close stdin or the CLI waits ~3s per call for piped input that never comes.
    child.stdin?.end();
  });
}

/**
 * Run `claude -p` and return the model's text, with automatic fallback to gemini-3.8-flash.
 * Shared by the scan and the AI recorder.
 *
 * opts.onMeta is called with { model, turns, costUsd } describing the run that ACTUALLY produced the
 * text, which is not always the one asked for — the fallback is silent by design, so a caller
 * recording provenance must be told, or it will faithfully record the model it intended to use while
 * a very different one wrote the output. `turns` is what makes grounding auditable: the Gemini
 * fallback has no codebase tools at all (turns: 0), and even Claude answering in a single turn never
 * opened the repo.
 */
function runGeminiCli(prompt, { timeout = 600000, signal, onMeta } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--output-format', 'json', '--approval-mode', 'yolo'];
    const child = execFile('gemini', args, { maxBuffer: 1024 * 1024 * 40, timeout, signal, env: process.env }, (err, stdout, stderr) => {
      if (err?.name === 'AbortError') return reject(new Error('cancelled'));
      if (err && !stdout) return reject(new Error(`Gemini CLI failed: ${String(stderr || err.message).trim().slice(0, 500)}`));
      try {
        const parsed = JSON.parse(stdout);
        const text = parsed.response || parsed.result || parsed.content || '';
        if (!text) throw new Error('Gemini CLI returned no response text');
        const toolCalls = parsed.stats?.tools?.totalCalls ?? parsed.tool_calls?.length ?? null;
        onMeta?.({ model: parsed.model || 'gemini-cli', turns: toolCalls, costUsd: null });
        resolve(text);
      } catch (parseErr) {
        if (stdout.trim()) resolve(stdout.trim()); else reject(parseErr);
      }
    });
    child.stdin?.end();
  });
}

/** Provider order: Claude CLI + Hadrius MCP first, Gemini CLI fallback. */
export async function runClaude(prompt, opts = {}) {
  try {
    return await runClaudeCli(prompt, opts);
  } catch (claudeErr) {
    if (opts.signal?.aborted) throw claudeErr;
    console.warn(`Claude CLI failed (${claudeErr.message}), falling back to Gemini CLI...`);
    return await runGeminiCli(prompt, opts);
  }
}

export function extractJson(text) {
  if (!text) throw new Error('empty model output');
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : text;
  const start = raw.indexOf('['), end = raw.lastIndexOf(']');
  const obj = raw.indexOf('{'), objEnd = raw.lastIndexOf('}');
  const slice = (start !== -1 && (obj === -1 || start < obj)) ? raw.slice(start, end + 1) : raw.slice(obj, objEnd + 1);
  return JSON.parse(slice);
}

// ---- Phase 1: modules + routes (deterministic source: the sidebar tab hooks) ----
export async function discoverModules(log = () => {}) {
  log('Phase 1: discovering modules from sidebar tabs…');
  const prompt = `You are indexing the Hadrius compliance web app (repo "hadrius_frontend") to build a table of product MODULES and the ROUTES each one owns.

Use ONLY the hadrius-codebase MCP tools. Do this:
1. list_directory on repo "hadrius_frontend", path "${SIDEBAR_DIR}". Each use_*_tab.tsx file (and use_tabs.tsx) defines sidebar tabs with a label and a "path".
2. read_file each of those files and extract every sidebar entry: its human label and its path (drop query strings). Group sub-tabs under their parent tab.
3. list_directory "${PAGES_DIR}" to see the page folders; map each module to the page folder(s) that implement it when obvious from the route or folder name.

Output ONLY a JSON array (no prose, no markdown) of modules:
[{"module":"Employees","module_path":"/people-oversight","routes":[{"label":"People directory","path":"/people-oversight/people-directory"},...],"page_dirs":["${PAGES_DIR}/employees"]}]
Rules: use the sidebar's own labels for module names; skip anything commented out; skip external links.

ONLY include a module if its sidebar label matches (case-insensitively, ignoring minor wording) one of these exactly — skip every other sidebar entry, including admin/consultant-only tabs:
${ALLOWED_MODULES.map((m) => `- ${m}`).join('\n')}`;
  const out = await runClaude(prompt, { maxTurns: 30 });
  const modules = extractJson(out);
  if (!Array.isArray(modules) || !modules.length) throw new Error('module discovery returned nothing');
  return modules;
}

// Enforce the allow-list and normalize casing. Applied in runScan() to BOTH the cached and the
// freshly discovered module map, so a stale cache on another machine can't bypass it.
function applyAllowList(modules, log) {
  const kept = modules
    .map((m) => ({ ...m, module: canonicalModule(m.module) }))
    .filter((m) => m.module);
  if (!kept.length) throw new Error(`no modules match the allow-list (${ALLOWED_MODULES.join(', ')}) — delete ${path.basename(CACHE_FILE)} and rescan`);
  const missing = ALLOWED_MODULES.filter((a) => !kept.some((m) => m.module === a));
  log(`Scanning ${kept.length} modules: ${kept.map((m) => m.module).join(', ')}`);
  return { modules: kept, missing };
}

// ---- Phase 2: multi-agent workflow discovery & deep planning ----

/** Stage 1: Discovery Agent surveys the module to identify discrete candidate workflows. */
export async function discoverCandidates(mod, log = () => {}) {
  log(`Phase 2A: discovering candidate workflows for "${mod.module}"…`);
  const routes = (mod.routes || []).map((r) => `- ${r.label}: ${r.path}`).join('\n');
  const dirs = (mod.page_dirs || []).join(', ') || PAGES_DIR;
  const prompt = `You are an indexing lead surveying the "${mod.module}" module of the Hadrius compliance web app (repo "hadrius_frontend").
Module routes:
${routes}
Likely page components: ${dirs}

Use the hadrius-codebase MCP tools (list_directory, search_code) to find all USER-FACING workflows a compliance officer or employee performs in this module.
Look for primary actions: adding/creating items, editing configurations, assigning reviewers, uploading documents, running searches/filters, generating reports, resolving exceptions, and performing sign-offs.

Output ONLY a JSON array of workflow candidates:
[
  {
    "title": "How to add a new policy",
    "description": "Upload a policy document and select which entities it covers.",
    "start_route": "/testing-program/policies",
    "trigger": "button \\"Add policy\\"",
    "priority": "high",
    "target_component": "add_policy_dialog.tsx"
  }
]
Rules:
- title MUST start with "How to " and be concise and descriptive.
- Aim for the 6-15 most valuable, distinct workflows for this module (no trivial duplicates).
- start_route is where the user begins (e.g. from the routes listed above).
- Output ONLY the JSON array, no markdown fences, no surrounding prose.`;

  const out = await runClaude(prompt, { maxTurns: 25 });
  const list = extractJson(out);
  if (!Array.isArray(list)) throw new Error(`candidate discovery for ${mod.module} returned non-array`);
  return list.filter((c) => c && c.title && c.start_route);
}

/** Stage 2: Dedicated Worker Agent inspects real code and formulates a deep, granular walkthrough plan. */
export async function deepPlanWorkflow(mod, cand, log = () => {}) {
  log(`  [Worker Agent] Deep planning "${cand.title}"…`);
  const prompt = `You are a technical compliance lead and educator on the Hadrius compliance web app (repo "hadrius_frontend", app code under apps/hadrius-app/src/).
We are creating a high-detail, source-grounded walkthrough guide for: "${cand.title}".
Module: "${mod.module}"
Starting route: "${cand.start_route}"
Workflow summary: "${cand.description || cand.purpose || ''}"
${cand.target_component ? `Target component hint: "${cand.target_component}"` : ''}

Use the hadrius-codebase MCP tools (search_code, read_file, list_directory) to inspect the real routes, pages, and components.
Find the exact buttons, dialog forms, wizard steps, inputs, and confirmations.

IMPORTANT RULES:
1. Step 1 MUST ALWAYS be the starting navigation step: "Navigate to ${mod.module} > <Tab/Section>".
2. Step 2 and subsequent steps MUST be granular, chronological actions referencing exact visible button and control labels in quotes (e.g. Click "Add policy", Enter policy name in "Name", Click "Save").
3. For EVERY step, prove it with source evidence:
   - "instruction": exact imperative step text
   - "route": the URL route where this happens
   - "control_label": exact button/input label or tab name
   - "evidence": { "file": "apps/...", "symbol": "...", "quote": "exact short code snippet" }
4. Return ONLY a valid JSON object in this exact shape:
{
  "title": "${cand.title}",
  "description": "${cand.description || cand.purpose || ''}",
  "start_route": "${cand.start_route}",
  "trigger": "${cand.trigger || ''}",
  "priority": "${cand.priority || 'medium'}",
  "steps": [
    {
      "instruction": "Navigate to ${mod.module} > ...",
      "route": "${cand.start_route}",
      "control_label": "...",
      "evidence": { "file": "apps/...", "symbol": "...", "quote": "..." }
    }
  ],
  "sources": ["apps/..."]
}
`;

  try {
    const out = await runClaude(prompt, { maxTurns: 30 });
    const plan = extractJson(out);
    if (!plan || !Array.isArray(plan.steps) || plan.steps.length < 2) {
      throw new Error('plan returned insufficient steps');
    }

    const startRoute = String(plan.start_route || cand.start_route).trim().replace(/\?.*$/, '') || '/';
    const matchedRoute = (mod.routes || []).find((r) => r.path === startRoute || startRoute.startsWith(r.path));
    const tabLabel = matchedRoute?.label || startRoute.split('/').filter(Boolean).pop()?.replace(/[-_]/g, ' ') || 'Overview';
    const navText = `Navigate to ${mod.module} > ${tabLabel.charAt(0).toUpperCase() + tabLabel.slice(1)}`;

    const steps = (plan.steps || []).map((step) => ({
      instruction: String(step.instruction || '').trim(),
      route: String(step.route || startRoute).trim(),
      control_label: step.control_label == null ? null : String(step.control_label).trim(),
      evidence: {
        file: String(step.evidence?.file || plan.sources?.[0] || 'source').trim(),
        symbol: String(step.evidence?.symbol || 'Component').trim(),
        quote: String(step.evidence?.quote || step.instruction || '').trim()
      }
    }));

    const firstInstruction = steps[0]?.instruction || '';
    const hasNav = /^(navigate to|open|go to)\s+/i.test(firstInstruction) &&
                   (firstInstruction.toLowerCase().includes(tabLabel.toLowerCase()) || firstInstruction.toLowerCase().includes(mod.module.toLowerCase())) &&
                   !firstInstruction.toLowerCase().includes('click');

    if (!hasNav && steps.length > 0) {
      steps.unshift({
        instruction: navText,
        route: startRoute,
        control_label: tabLabel,
        evidence: { file: 'navigation', symbol: 'SidebarNav', quote: navText }
      });
    }

    return {
      module: mod.module,
      module_path: mod.module_path || null,
      title: String(plan.title || cand.title).trim(),
      description: plan.description || cand.description || null,
      start_route: startRoute,
      trigger: String(plan.trigger || cand.trigger || '').trim() || `button "${cand.title}"`,
      priority: ['high', 'medium', 'low'].includes(plan.priority) ? plan.priority : (cand.priority || 'medium'),
      steps,
      sources: [...new Set((plan.sources || [cand.target_component]).map(String).filter(Boolean))]
    };
  } catch (err) {
    log(`    ! Worker plan fallback for "${cand.title}": ${err.message}`);
    const startRoute = String(cand.start_route).trim().replace(/\?.*$/, '') || '/';
    const matchedRoute = (mod.routes || []).find((r) => r.path === startRoute || startRoute.startsWith(r.path));
    const tabLabel = matchedRoute?.label || startRoute.split('/').filter(Boolean).pop()?.replace(/[-_]/g, ' ') || 'Overview';
    const navText = `Navigate to ${mod.module} > ${tabLabel.charAt(0).toUpperCase() + tabLabel.slice(1)}`;

    return {
      module: mod.module,
      module_path: mod.module_path || null,
      title: String(cand.title).trim(),
      description: cand.description || null,
      start_route: startRoute,
      trigger: String(cand.trigger || '').trim() || `button "${cand.title}"`,
      priority: cand.priority || 'medium',
      steps: [
        { instruction: navText, route: startRoute, control_label: tabLabel, evidence: { file: 'navigation', symbol: 'SidebarNav', quote: navText } },
        { instruction: `Follow the steps for ${cand.title}`, route: startRoute, control_label: null, evidence: { file: cand.target_component || 'source', symbol: 'Page', quote: cand.title } }
      ],
      sources: [cand.target_component].filter(Boolean)
    };
  }
}

/** Orchestrates the two-stage multi-agent pipeline for a module. */
export async function discoverWorkflows(mod, log = () => {}) {
  log(`Phase 2: discovering workflows for "${mod.module}" via multi-agent pipeline…`);
  const candidates = await discoverCandidates(mod, log);
  log(`  ${mod.module}: discovered ${candidates.length} opportunities. Deploying parallel worker agents…`);

  const workflows = [];
  const WORKER_CONCURRENCY = 3;

  for (let i = 0; i < candidates.length; i += WORKER_CONCURRENCY) {
    const batch = candidates.slice(i, i + WORKER_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((c) => deepPlanWorkflow(mod, c, log)));
    results.forEach((r) => {
      if (r.status === 'fulfilled' && r.value) {
        workflows.push(r.value);
      }
    });
  }

  log(`  ✓ ${mod.module}: completed deep planning for ${workflows.length} workflows.`);
  return workflows;
}

export async function runScan({ onlyModule = null, log = () => {}, useCache = true } = {}) {
  let modules;
  if (useCache && fs.existsSync(CACHE_FILE)) {
    try { modules = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')).modules; log(`Using cached module map (${modules.length} modules); delete ${path.basename(CACHE_FILE)} to rediscover.`); } catch {}
  }
  if (!modules) {
    modules = await discoverModules(log);
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ scannedAt: new Date().toISOString(), modules }, null, 2));
  }
  const allow = applyAllowList(modules, log);
  modules = allow.modules;
  const targets = onlyModule ? modules.filter((m) => m.module.toLowerCase() === String(onlyModule).toLowerCase()) : modules;
  if (!targets.length) throw new Error(`module "${onlyModule}" not found; known: ${modules.map((m) => m.module).join(', ')}`);

  const candidates = [];
  const errors = [];
  // A missing allow-listed module (renamed sidebar tab, cache drift) is a real error, not a log line:
  // it must surface in the scan result and must block any "full scan" semantics.
  for (const m of allow.missing) errors.push({ module: m, error: 'not found in the sidebar this scan — was the tab renamed? Delete .coverage-scan-cache.json to rediscover.' });
  // modest parallelism: each call is a full claude session
  const CONC = 3;
  for (let i = 0; i < targets.length; i += CONC) {
    const batch = targets.slice(i, i + CONC);
    const results = await Promise.allSettled(batch.map((m) => discoverWorkflows(m, log)));
    results.forEach((r, j) => {
      if (r.status === 'fulfilled') candidates.push(...r.value);
      else { errors.push({ module: batch[j].module, error: String(r.reason?.message || r.reason) }); log(`  ! ${batch[j].module}: ${r.reason?.message || r.reason}`); }
    });
  }
  // full_scan tells the shared coverage API it may prune candidates absent from this run. Since the
  // scan is now deliberately scoped to ALLOWED_MODULES, it is never a full inventory of the app —
  // marking it "full" would delete every other module's shared rows (links, dismissals) for everyone.
  // Stale rows outside the allow-list are hidden by the bridge's /coverage filter instead.
  return { modules, candidates, errors, full_scan: false };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const mi = process.argv.indexOf('--module');
  const onlyModule = mi !== -1 ? process.argv[mi + 1] : null;
  runScan({ onlyModule, log: (m) => console.error(m) })
    .then((r) => { console.log(JSON.stringify(r, null, 2)); })
    .catch((e) => { console.error('scan failed:', e.message); process.exit(1); });
}

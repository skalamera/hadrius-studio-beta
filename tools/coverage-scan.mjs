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

/** Temporary provider order: Gemini CLI + Hadrius MCP first, Claude CLI fallback only. */
export async function runClaude(prompt, opts = {}) {
  try {
    return await runGeminiCli(prompt, opts);
  } catch (geminiErr) {
    if (opts.signal?.aborted) throw geminiErr;
    console.warn(`Gemini CLI failed (${geminiErr.message}), temporarily falling back to Claude CLI...`);
    return await runClaudeCli(prompt, opts);
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

// ---- Phase 2: workflows per module (AI judgement over page components) ----
export async function discoverWorkflows(mod, log = () => {}) {
  log(`Phase 2: scanning "${mod.module}" for workflows…`);
  const routes = (mod.routes || []).map((r) => `- ${r.label}: ${r.path}`).join('\n');
  const dirs = (mod.page_dirs || []).join(', ') || PAGES_DIR;
  const prompt = `You are a product-education lead deciding which workflows in the "${mod.module}" module of the Hadrius compliance web app (repo "hadrius_frontend") deserve a short recorded how-to video.

The module's routes:
${routes}
Likely page code: ${dirs}

Use ONLY the hadrius-codebase MCP tools (list_directory, read_file, search_code, file_tree). Look at the page components for these routes and find USER-FACING workflows a compliance officer or employee would actually perform: primary action buttons (e.g. "Add employees", "New test", "Send invite", "Export"), create/edit dialogs and multi-step wizards, approvals/reviews, connecting integrations, bulk actions, imports/exports, settings that must be configured. Ignore purely internal, admin-only debugging, or trivial navigation ("view the list").

For each workflow output:
{"title":"How to add an employee","description":"one sentence of what the user accomplishes","start_route":"/people-oversight/people-directory","trigger":"button \\"Add employees\\"","priority":"high|medium|low","steps":[{"instruction":"Navigate to People oversight > People directory","route":"/people-oversight/people-directory","control_label":"People directory","evidence":{"file":"apps/.../use_employee_tab.tsx","symbol":"visible component or function name","quote":"short exact source excerpt proving this step"}},{"instruction":"Click \\"Add employees\\" to open the dialog.","route":"/people-oversight/people-directory","control_label":"Add employees","evidence":{"file":"apps/.../page_people_directory.tsx","symbol":"AddEmployeesButton","quote":"<Button>Add employees</Button>"}}],"sources":["apps/.../use_employee_tab.tsx","apps/.../page_people_directory.tsx"]}
- title MUST start with "How to" and be specific.
- Step 1 MUST ALWAYS be the navigation step specifying where to begin: "Navigate to <Module> > <Tab/Section>" (e.g. "Navigate to Testing program > Policies").
- Step 2 and subsequent steps are the user actions performed on that page/dialog.
- Every step MUST be directly proven by source code read through the Hadrius MCP.
- Every step requires an exact route, visible control label (or null only for initial page arrival), source file, symbol, and short exact code quote.
- Do not infer labels, dialogs, fields, ordering, success states, or navigation. If source code does not prove a step, omit the step.
- Reject a workflow unless it has at least two source-proven user actions and its trigger label is present in source.
- start_route is where the user begins (a route from the list above or a child of one).
- priority: high = core daily task or onboarding-critical; medium = periodic; low = rare/edge.
- Aim for the 4-15 most valuable workflows for this module, no duplicates, no filler.

Output ONLY a JSON array, no prose, no markdown.`;
  const out = await runClaude(prompt, { maxTurns: 40 });
  const list = extractJson(out);
  if (!Array.isArray(list)) throw new Error(`workflow scan for ${mod.module} returned non-array`);
  const cleaned = list
    .filter((w) => w && w.title && w.start_route && w.trigger && Array.isArray(w.steps) && w.steps.length >= 2)
    .map((w) => {
      const startRoute = String(w.start_route).trim().replace(/\?.*$/, '') || '/';
      const matchedRoute = (mod.routes || []).find((r) => r.path === startRoute || startRoute.startsWith(r.path));
      const tabLabel = matchedRoute?.label || startRoute.split('/').filter(Boolean).pop()?.replace(/[-_]/g, ' ') || 'Overview';
      const navText = `Navigate to ${mod.module} > ${tabLabel.charAt(0).toUpperCase() + tabLabel.slice(1)}`;

      const steps = w.steps.filter((step) => step?.instruction && step?.route && step?.evidence?.file && step?.evidence?.symbol && step?.evidence?.quote).map((step) => ({
        instruction: String(step.instruction).trim(),
        route: String(step.route).trim(),
        control_label: step.control_label == null ? null : String(step.control_label).trim(),
        evidence: { file: String(step.evidence.file).trim(), symbol: String(step.evidence.symbol).trim(), quote: String(step.evidence.quote).trim() }
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
        title: String(w.title).trim(),
        description: w.description ? String(w.description).trim() : null,
        start_route: startRoute,
        trigger: String(w.trigger).trim(),
        priority: ['high', 'medium', 'low'].includes(w.priority) ? w.priority : 'medium',
        steps,
        sources: [...new Set((w.sources || []).map(String).filter(Boolean))]
      };
    })
    .filter((w) => w.steps.length >= 2);
  log(`  ${mod.module}: ${cleaned.length} workflows`);
  return cleaned;
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

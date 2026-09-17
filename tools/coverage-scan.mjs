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

/**
 * execFile's own `timeout` option only signals the DIRECT child. Both the `claude` and `gemini`
 * CLIs are themselves Node launchers that fork a real worker process — killing the launcher leaves
 * that worker running as an orphan, so the intended timeout never actually bounds wall-clock time
 * (observed: a `gemini` worker kept burning CPU for 3+ minutes after its 25s timeout should have
 * fired, hanging an entire AI-recorder turn on one unanswered "consult"). Spawning `detached` makes
 * the child the leader of its own process group, so killing `-pid` (negative = the whole group)
 * reaches every descendant, not just the one Node is directly tracking.
 */
function killProcessGroupSoon(child, timeoutMs, signal) {
  const graceMs = 3000; // let execFile's own timeout/killSignal try first; this is the backstop
  const killGroup = () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    try { child.kill('SIGKILL'); } catch (_) {}
  };
  const timer = setTimeout(killGroup, timeoutMs + graceMs);
  timer.unref?.();
  // A user cancelling mid-call aborts `signal` immediately — execFile's own abort handling kills
  // only the direct child (same orphan gap as the timeout), so do the group-kill here too.
  signal?.addEventListener?.('abort', killGroup, { once: true });
  return () => { clearTimeout(timer); signal?.removeEventListener?.('abort', killGroup); };
}

function runClaudeCli(prompt, { maxTurns = 40, timeout = 600000, allowedTools = ALLOWED_TOOLS, noTools = false, systemPrompt = null, model = planModel(), signal, onMeta } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--output-format', 'json', '--max-turns', String(maxTurns), '--model', model];
    // (not --bare: it skips the settings the keychain login lookup needs and reports "Not logged in")
    if (noTools) args.push('--tools', '', '--strict-mcp-config', '--no-session-persistence');
    else if (allowedTools) args.push('--allowedTools', allowedTools);
    if (systemPrompt) args.push('--system-prompt', systemPrompt);
    const child = execFile('claude', args, { maxBuffer: 1024 * 1024 * 40, timeout, killSignal: 'SIGKILL', detached: true, signal, env: claudeEnv() }, (err, stdout, stderr) => {
      clearWatchdog();
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
    const clearWatchdog = killProcessGroupSoon(child, timeout, signal);
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
    const args = ['-p', prompt, '--output-format', 'json', '--approval-mode', 'plan', '--skip-trust'];
    const env = { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: 'true' };
    // cwd matters: launchd starts the bridge with cwd "/", and gemini run from the filesystem root
    // prints "You are running Gemini CLI in the root directory" and returns nothing usable — which
    // is why the fallback never actually worked for jobs started by the background bridge.
    const child = execFile('gemini', args, { cwd: REPO_ROOT, maxBuffer: 1024 * 1024 * 40, timeout, killSignal: 'SIGKILL', detached: true, signal, env }, (err, stdout, stderr) => {
      clearWatchdog();
      if (err?.name === 'AbortError') return reject(new Error('cancelled'));
      if (err && !stdout) return reject(new Error(`Gemini CLI failed: ${String(stderr || err.message).trim().slice(0, 500)}`));
      try {
        let clean = stdout;
        const start = stdout.indexOf('{');
        const end = stdout.lastIndexOf('}');
        if (start !== -1 && end > start) {
          clean = stdout.slice(start, end + 1);
        }
        const parsed = JSON.parse(clean);
        const text = parsed.response || parsed.result || parsed.content || parsed.text || parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (!text) throw new Error('Gemini CLI returned no response text');
        const toolCalls = parsed.stats?.tools?.totalCalls ?? parsed.tool_calls?.length ?? null;
        onMeta?.({ model: parsed.model || 'gemini-cli', turns: toolCalls, costUsd: null });
        resolve(text);
      } catch (parseErr) {
        if (stdout.trim()) resolve(stdout.trim()); else reject(parseErr);
      }
    });
    const clearWatchdog = killProcessGroupSoon(child, timeout, signal);
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
    try {
      return await runGeminiCli(prompt, opts);
    } catch (geminiErr) {
      if (opts.signal?.aborted) throw geminiErr;
      // Report BOTH, Claude first. When only Gemini's message surfaced, a whole batch of jobs
      // failed with "Gemini CLI failed: Warning: You are running Gemini CLI in the root directory"
      // — pure noise that hid the actual cause (the Claude account had hit its spend limit).
      throw new Error(`both models failed — Claude: ${claudeErr.message} | Gemini: ${geminiErr.message}`);
    }
  }
}

export function extractJson(text) {
  if (!text || typeof text !== 'string') throw new Error('empty model output');
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : text;
  const startObj = raw.indexOf('{');
  const endObj = raw.lastIndexOf('}');
  const startArr = raw.indexOf('[');
  const endArr = raw.lastIndexOf(']');

  let slice = null;
  if (startObj !== -1 && endObj > startObj) {
    if (startArr !== -1 && startArr < startObj && endArr > endObj) {
      slice = raw.slice(startArr, endArr + 1);
    } else {
      slice = raw.slice(startObj, endObj + 1);
    }
  } else if (startArr !== -1 && endArr > startArr) {
    slice = raw.slice(startArr, endArr + 1);
  }

  if (!slice) throw new Error(`no JSON structure found in output (received: "${text.slice(0, 80)}...")`);
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

const STOP_WORDS = new Set(['how', 'to', 'a', 'an', 'the', 'in', 'on', 'for', 'of', 'and', 'with', 'new', 'your']);
const SYNONYMS = {
  add: 'create', adding: 'create', create: 'create', creating: 'create', make: 'create',
  edit: 'update', editing: 'update', update: 'update', updating: 'update', modify: 'update',
  delete: 'remove', deleting: 'remove', remove: 'remove', removing: 'remove'
};

export function workflowTokens(s) {
  return new Set(
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((t) => t && !STOP_WORDS.has(t))
      .map((t) => SYNONYMS[t] || t)
  );
}

export function workflowSimilarity(a, b) {
  const ta = workflowTokens(a), tb = workflowTokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0; ta.forEach((t) => { if (tb.has(t)) inter++; });
  return inter / Math.max(ta.size, tb.size);
}

export function findMatchingWorkflow(candidate, existingList = []) {
  if (!existingList.length) return null;
  const candRoute = String(candidate.start_route || candidate.startRoute || '').replace(/\/+$/, '');
  let best = null;
  let bestScore = 0;

  for (const ex of existingList) {
    const exTitle = ex.title || ex.name || '';
    const exRoute = String(ex.startRoute || ex.start_route || '').replace(/\/+$/, '');
    const sameRoute = exRoute && (exRoute === candRoute || exRoute.startsWith(candRoute + '/') || candRoute.startsWith(exRoute + '/'));
    const sim = workflowSimilarity(candidate.title, exTitle);
    const score = sim + (sameRoute ? 0.35 : 0);

    if (score > bestScore && score >= 0.70) {
      bestScore = score;
      best = ex;
    }
  }

  return best;
}

/** Stage 1: Discovery Agent surveys the module to identify discrete candidate workflows. */
export async function discoverCandidates(mod, log = () => {}, existingList = []) {
  log(`Phase 2A: discovering candidate workflows for "${mod.module}"…`);
  const routes = (mod.routes || []).map((r) => `- ${r.label}: ${r.path}`).join('\n');
  const dirs = (mod.page_dirs || []).join(', ') || PAGES_DIR;

  let existingBlock = '';
  if (existingList.length > 0) {
    existingBlock = `\nEXISTING WORKFLOWS ALREADY RECORDED IN THIS MODULE:
${existingList.map((w) => `- "${w.title}" (Start route: ${w.startRoute || w.start_route || '/'})`).join('\n')}

DEDUPLICATION RULES:
1. Do NOT create duplicate workflows for user tasks already covered in the list above.
2. If an existing workflow is still valid in code, reuse its EXACT title above so it updates in-place instead of creating a second entry.
3. Only propose new titles for genuinely new user actions, screens, or features not yet in the list.\n`;
  }

  const prompt = `You are an indexing lead surveying the "${mod.module}" module of the Hadrius compliance web app (repo "hadrius_frontend").
Module routes:
${routes}
Likely page components: ${dirs}
${existingBlock}
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

  const filtered = list.filter((c) => c && c.title && c.start_route);

  // Semantic deduplication against existing workflows
  for (const c of filtered) {
    const match = findMatchingWorkflow(c, existingList);
    if (match) {
      log(`    [Deduplicated] "${c.title}" mapped to existing workflow "${match.title}"`);
      c.title = match.title;
      c.key = match.key || null;
      c.matched_existing = true;
    }
  }

  return filtered;
}

/** Stage 2: Dedicated Worker Agent inspects real code and formulates a deep, granular walkthrough plan. */
// The one grounding standard every plan-writing path shares (scan, Generate plan, Enhance plan).
// Plans drive a browser agent that follows them literally, so a step it can't map to one exact
// control is where it stalls — hence per-step proof and an honest verified flag, which the UI
// turns into "Auto-record available" or not.
export const GROUNDING_CONTRACT = `GROUNDING CONTRACT (non-negotiable):
- Read the real code first: the page component behind the start route, then every dialog, drawer, menu, wizard step, or table component a step touches. Read as many files as it takes — there is no tool-call budget. Never write a step from memory or inference.
- Routes: the start route must resolve — a file under apps/hadrius-app/pages/** or a rewrite source in apps/hadrius-app/next.config.js. Prefer the path the sidebar links to; the sidebar labels live in the nav config (search_code for a known label such as "People directory").
- Every step is ONE concrete action on ONE concrete target: navigate to a route, click a control, type into a field, choose an option, upload a file, or wait for a specific visible result (toast text, dialog title, row appearing). Quote the target's label exactly as it appears in the JSX (button text, tab name, dialog title, field label, menu item, aria-label). No "configure as needed", "review the settings", "complete the form" — if a form has fields, list them.
- Icon-only controls: say so and quote the aria-label or tooltip; say where it sits ("the vertical-ellipsis button at the right end of the row").
- For each step record proof: the file you read, and a short verbatim quote from it containing the label or route. Mark "verified": true ONLY if you read that file and saw that label/route in it. If you could not confirm a step in the code — or a label is rendered from data you cannot see — mark "verified": false and say why in "reason". Do not guess to fill the gap; an unverified step honestly flagged is worth more than a plausible one.
- Gating counts as a prerequisite: feature flags, admin/role checks, disabled-state conditions, module activation, data that must already exist. Say which and cite where.
- "confidence" is "high" only when every step is verified and the route resolves; "medium" when the flow is clear but one or two labels or a branch could not be confirmed; "low" when the goal isn't reachable as titled or several steps are unconfirmed.`;

// Compute the plan's verification record from the model's per-step proof, never from its
// self-reported confidence alone: a plan is only "high" if every step is actually pinned.
export function assessGrounding(plan) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const proofs = Array.isArray(plan?.step_grounding) ? plan.step_grounding : steps.map((s) => (s && typeof s === 'object' ? s.evidence : null));
  const unverified = [];
  const detail = steps.map((step, i) => {
    const p = proofs[i] || {};
    const text = typeof step === 'string' ? step : (step?.instruction || '');
    const isNav = i === 0 && /^(navigate to|open|go to)\s+/i.test(text);
    const verified = p.verified === true && !!String(p.file || '').trim() && String(p.file) !== 'source';
    if (!verified && !isNav) unverified.push({ step: i + 1, reason: String(p.reason || (p.file ? 'label not confirmed in source' : 'no source read for this step')).slice(0, 200) });
    return { step: i + 1, file: p.file ? String(p.file).slice(0, 300) : null, quote: p.quote ? String(p.quote).slice(0, 300) : null, verified: verified || isNav };
  });
  const claimed = ['high', 'medium', 'low'].includes(plan?.confidence) ? plan.confidence : 'low';
  let confidence = 'low';
  if (steps.length >= 3 && unverified.length === 0) confidence = claimed === 'low' ? 'medium' : 'high';
  else if (steps.length >= 3 && unverified.length <= 2 && unverified.length < steps.length / 2) confidence = claimed === 'high' ? 'medium' : claimed;
  return { confidence, verifiedSteps: steps.length - unverified.length, totalSteps: steps.length, unverified, steps: detail, checkedAt: new Date().toISOString() };
}

export async function deepPlanWorkflow(mod, cand, log = () => {}) {
  log(`  [Worker Agent] Deep planning "${cand.title}"…`);
  const prompt = `You are a technical compliance lead and educator on the Hadrius compliance web app (repo "hadrius_frontend", app code under apps/hadrius-app/src/).
We are creating a high-detail, source-grounded walkthrough guide for: "${cand.title}".
Module: "${mod.module}"
Starting route: "${cand.start_route}"
Workflow summary: "${cand.description || cand.purpose || ''}"
${cand.target_component ? `Target component hint: "${cand.target_component}"` : ''}

Use the hadrius-codebase MCP tools (search_code, read_file, list_directory, file_tree) to inspect the real routes, pages, and components.
Routing is two-layer: apps/hadrius-app/pages/** are thin route files; the real UI lives under apps/hadrius-app/src/pages/coreloop/** (module display names do not match folder names — search for labels and route strings rather than guessing folders).

${GROUNDING_CONTRACT}

IMPORTANT RULES:
1. Step 1 MUST ALWAYS be the starting navigation step: "Navigate to ${mod.module} > <Tab/Section>".
2. Step 2 and subsequent steps MUST be granular, chronological actions referencing exact visible button and control labels in quotes (e.g. Click "Add policy", Enter policy name in "Name", Click "Save").
3. For EVERY step, prove it with source evidence:
   - "instruction": exact imperative step text
   - "route": the URL route where this happens
   - "control_label": exact button/input label or tab name
   - "evidence": { "file": "apps/...", "symbol": "...", "quote": "exact short code snippet", "verified": true|false, "reason": "only when verified is false" }
4. Also determine "prerequisites": what must already exist in the app (a record in a specific status, a permission, a feature flag, a second entity) before these steps are actually possible — a fresh/typical company might not have it by default. Use search_code to check for disabled-state conditions, role/permission gates, or feature flags backing the action. Skip file uploads (already handled automatically by the recorder). List each as a short plain-English line. Empty array if nothing special is required.
5. Set "provisionable" to one of: "none-needed" (works on any account), "likely-already-present" (a normal active company already has this kind of data), "self-serve-quick" (missing by default but any operator could create it in a couple of clicks first), "needs-deliberate-setup" (needs a longer multi-step sequence first), or "structurally-blocked" (cannot be created through the UI at all in this environment — e.g. only a backend seed, an external system sync, or a feature flag flip by Hadrius ops could do it). If "structurally-blocked", also set "blocker_reason" to the specific, cited reason.
6. If the workflow's final step starts a background export/download job (a queued/"Preparing…" job rather than an immediate download), the LAST step is the export being requested, not the job finishing — never write a step that waits for the file to build or downloads it. If a toast or the page offers a one-click way to see where the finished file will land (e.g. "Open export" in the toast, a link to an Exports page), that navigation can be the last step; otherwise end at the request itself.
7. Return ONLY a valid JSON object in this exact shape:
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
      "evidence": { "file": "apps/...", "symbol": "...", "quote": "...", "verified": true }
    }
  ],
  "sources": ["apps/..."],
  "prerequisites": ["short line each: role, data or setting required"],
  "provisionable": "none-needed",
  "blocker_reason": "",
  "confidence": "high"
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
        quote: String(step.evidence?.quote || step.instruction || '').trim(),
        verified: step.evidence?.verified === true,
        ...(step.evidence?.reason ? { reason: String(step.evidence.reason).trim() } : {})
      }
    }));
    const grounding = assessGrounding({ steps, confidence: plan.confidence });

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
      sources: [...new Set((plan.sources || [cand.target_component]).map(String).filter(Boolean))],
      prerequisites: Array.isArray(plan.prerequisites) ? plan.prerequisites.map(String).filter(Boolean) : [],
      provisionable: ['none-needed', 'likely-already-present', 'self-serve-quick', 'needs-deliberate-setup', 'structurally-blocked'].includes(plan.provisionable) ? plan.provisionable : null,
      blocker_reason: String(plan.blocker_reason || '').trim(),
      grounding
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
        { instruction: `Follow the steps for ${cand.title}`, route: startRoute, control_label: null, evidence: { file: cand.target_component || 'source', symbol: 'Page', quote: cand.title, verified: false, reason: 'planner failed; placeholder step' } }
      ],
      sources: [cand.target_component].filter(Boolean),
      grounding: { confidence: 'low', verifiedSteps: 1, totalSteps: 2, unverified: [{ step: 2, reason: `planner failed: ${String(err.message).slice(0, 160)}` }], steps: [], checkedAt: new Date().toISOString() }
    };
  }
}

/** Orchestrates the two-stage multi-agent pipeline for a module. */
export async function discoverWorkflows(mod, log = () => {}, existingList = []) {
  log(`Phase 2: discovering workflows for "${mod.module}" via multi-agent pipeline…`);
  const candidates = await discoverCandidates(mod, log, existingList);
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

export async function runScan({ onlyModule = null, log = () => {}, useCache = true, existingWorkflows = [] } = {}) {
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
  for (const m of allow.missing) errors.push({ module: m, error: 'not found in the sidebar this scan — was the tab renamed? Delete .coverage-scan-cache.json to rediscover.' });

  const CONC = 3;
  for (let i = 0; i < targets.length; i += CONC) {
    const batch = targets.slice(i, i + CONC);
    const results = await Promise.allSettled(batch.map((m) => {
      const existingForMod = (existingWorkflows || []).filter((w) => (w.module || '').toLowerCase() === m.module.toLowerCase());
      return discoverWorkflows(m, log, existingForMod);
    }));
    results.forEach((r, j) => {
      if (r.status === 'fulfilled') candidates.push(...r.value);
      else { errors.push({ module: batch[j].module, error: String(r.reason?.message || r.reason) }); log(`  ! ${batch[j].module}: ${r.reason?.message || r.reason}`); }
    });
  }

  return { modules, candidates, errors, full_scan: false };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const mi = process.argv.indexOf('--module');
  const onlyModule = mi !== -1 ? process.argv[mi + 1] : null;
  runScan({ onlyModule, log: (m) => console.error(m) })
    .then((r) => { console.log(JSON.stringify(r, null, 2)); })
    .catch((e) => { console.error('scan failed:', e.message); process.exit(1); });
}

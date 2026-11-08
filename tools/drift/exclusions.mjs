// Temporary drift exclusions (tools/drift/exclusions.json): videos handled by someone else are skipped by every drift
// path (weekly runner name selection, PR early checks, weekly submit, executor).
// Rule {module, topicModule?, reason?}: the video's module (script module, case-insensitive; a script without one uses
// the bridge's route-based inference via modules.mjs resolveModuleSync) equals `module`, AND when `topicModule` is set
// the walkthrough is about that area: any start/step URL whose route maps to it (e.g. /marketing -> Marketing, same
// route table as inferModuleFromScript) or the route-inferred module itself. Legacy `modules:[...]` = module-only rules.
// Remove the rule (or delete exclusions.json) to include the videos again.
// Import-safe: nothing is read until a function is called.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inferModuleFromScript } from '../coverage-scan.mjs';
import { resolveModuleSync } from './modules.mjs';

export const EXCLUSIONS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'exclusions.json');
const EMPTY = Object.freeze({ schema: 2, rules: [], reason: null, addedAt: null, addedBy: null, source: null });

/** Parsed exclusions; a missing file = no exclusions. An unreadable/invalid file throws (fail closed: a run with a
 *  broken exclusion list could post videos someone else owns). */
export function loadExclusions(file = EXCLUSIONS_PATH) {
  if (!fs.existsSync(file)) return { ...EMPTY, rules: [] };
  return parseExclusions(fs.readFileSync(file, 'utf8'), file);
}
const str = (v) => typeof v === 'string' && v.trim();
export function parseExclusions(text, source = null) {
  const o = typeof text === 'string' ? JSON.parse(text) : text;
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('exclusions_not_object');
  const legacy = o.modules ?? [];
  if (!Array.isArray(legacy) || legacy.some((m) => !str(m))) throw new Error('exclusions_modules_invalid');
  const rawRules = o.rules ?? [];
  if (!Array.isArray(rawRules) || rawRules.some((r) => !r || typeof r !== 'object' || !str(r.module) || (r.topicModule != null && !str(r.topicModule)))) throw new Error('exclusions_rules_invalid');
  const rules = [...legacy.map((m) => ({ module: m.trim() })), ...rawRules.map((r) => ({ module: r.module.trim(), ...(r.topicModule ? { topicModule: r.topicModule.trim() } : {}), ...(str(r.reason) ? { reason: r.reason.trim() } : {}) }))]
    .map((r) => ({ ...r, id: ruleId(r) }));
  return { schema: o.schema ?? 2, rules, reason: o.reason ?? null, addedAt: o.addedAt ?? null, addedBy: o.addedBy ?? null, source };
}
/** Stable rule id used in reports and counts: module:<m>[+topic:<t>]. */
export const ruleId = (r) => `module:${r.module}${r.topicModule ? `+topic:${r.topicModule}` : ''}`;
export const hasRules = (ex) => !!(ex?.rules?.length || ex?.modules?.length);
const rulesOf = (ex) => (ex?.rules ? ex.rules : parseExclusions(ex ?? {}).rules);

/** {module, source} the exclusion matches on: explicit script module, else the route-inferred one, else the raw label. */
export function moduleOf(script) {
  const r = resolveModuleSync(script);
  return { module: r.module, source: r.source };
}
/** Areas a walkthrough visits: the route-inferred module of every start/step URL (+ the overall inferred module). */
export function topicModulesOf(script) {
  const urls = [script?.environment?.startUrl, ...(script?.steps || []).flatMap((s) => [s?.url, s?.action === 'navigate' ? s?.value : null])].filter((u) => typeof u === 'string' && /^https?:/.test(u));
  const out = new Set(urls.map((u) => inferModuleFromScript({ environment: { startUrl: u }, steps: [] })).filter(Boolean));
  const all = inferModuleFromScript(script); if (all) out.add(all);
  return [...out];
}

/** null, or {excluded:true, rule, module, moduleSource, topicModule?, reason, addedAt, addedBy}. */
export function exclusionFor(script, exclusions) {
  if (!script || !hasRules(exclusions)) return null;
  const rules = rulesOf(exclusions);
  const r = moduleOf(script);
  const mods = [[r.module, r.source]];
  if (str(script.module) && script.module.trim().toLowerCase() !== String(r.module || '').toLowerCase()) mods.push([script.module.trim(), 'raw']);
  let topics = null;
  for (const rule of rules) for (const [m, source] of mods) {
    if (!m || String(m).toLowerCase() !== rule.module.toLowerCase()) continue;
    if (rule.topicModule) { topics ??= topicModulesOf(script).map((t) => t.toLowerCase()); if (!topics.includes(rule.topicModule.toLowerCase())) continue; }
    return { excluded: true, rule: rule.id ?? ruleId(rule), module: m, moduleSource: source, ...(rule.topicModule ? { topicModule: rule.topicModule } : {}),
      reason: rule.reason ?? exclusions.reason ?? 'excluded', addedAt: exclusions.addedAt ?? null, addedBy: exclusions.addedBy ?? null };
  }
  return null;
}

/**
 * Split names into kept / excluded. readScript(name) -> script|null (unreadable scripts are kept: the caller reports
 * them as missing). Returns {kept, excluded:[{name, ...exclusion}], counts:{<rule>: n}}.
 */
export function partitionNames(names, { readScript, exclusions }) {
  const kept = [], excluded = [], counts = {};
  for (const name of names || []) {
    let script = null; try { script = readScript(name); } catch { script = null; }
    const ex = exclusionFor(script, exclusions);
    if (ex) { excluded.push({ name, ...ex }); counts[ex.rule] = (counts[ex.rule] || 0) + 1; } else kept.push(name);
  }
  return { kept, excluded, counts };
}

/** Reader for scripts/<name>.script.json under a repo root (null when absent/unparsable). */
export const repoScriptReader = (repo) => (name) => {
  try { return JSON.parse(fs.readFileSync(path.join(repo, 'scripts', `${name}.script.json`), 'utf8')); } catch { return null; }
};

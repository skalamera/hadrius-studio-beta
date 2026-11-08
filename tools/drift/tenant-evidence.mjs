// Tenant evidence for walkthroughs whose script URLs name no company_id: the recording itself shows which company it
// was made in (the app's company switcher, top-left: "Hadrius Sandbox 1048" / "Hadrius Academy 1150"). This module
// reads that switcher on the recorded frames with offline OCR and records an auditable, recording-bound decision in
// tools/drift/tenant-evidence.json, which tenants.detectScriptTenant consults ONLY when the URLs name no company.
//
// A tenant is assigned only when ALL hold (otherwise the script stays 'unknown' and is never replayed):
//  - every URL in the script (startUrl, step urls, navigate values) is on https://app.hadrius.com (staging recordings
//    are excluded: a production replay of them would compare different environments);
//  - at least MIN_AGREEING_FRAMES of the first FRAMES_CHECKED recorded frames show the same tenant's name AND company id
//    in the switcher region, and no frame shows the other tenant or a STAGING badge;
//  - the entry is bound to the script's recording id and each frame's file name + sha256 (a re-recording invalidates it).
//
// CLI: node tools/drift/tenant-evidence.mjs [--write]      (macOS only: uses tools/drift/ocr-text.swift)
// Import-safe: no side effects.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EVIDENCE_PATH = join(REPO, 'tools', 'drift', 'tenant-evidence.json');
export const METHOD = 'recorded-company-switcher-ocr-v1';
export const SWITCHER_ROI = '0,0,0.2,0.16'; // top-left 320x144 of a 1600x900 frame (normalized, top-left origin)
export const FRAMES_CHECKED = 3, MIN_AGREEING_FRAMES = 2;
const APP_ORIGIN = 'https://app.hadrius.com';
// Name AND id must both be read; the switcher shows "Hadrius Sandbox  1048".
const PATTERNS = { sandbox: { name: /Hadrius\s+Sandbox/i, id: /\b1048\b/ }, academy: { name: /Hadrius\s+Academy/i, id: /\b1150\b/ } };
const STAGING_RE = /\bSTAGING\b/;

/** Every URL the script names. */
export function scriptUrls(script) {
  const out = [];
  if (script?.environment?.startUrl) out.push(script.environment.startUrl);
  for (const s of script?.steps ?? []) { if (s?.url) out.push(s.url); if (s?.action === 'navigate' && typeof s.value === 'string' && /^https?:/.test(s.value)) out.push(s.value); }
  return out;
}
export function allOnProductionApp(script) {
  const urls = scriptUrls(script);
  return urls.length > 0 && urls.every((u) => { try { return new URL(u).origin === APP_ORIGIN; } catch { return false; } });
}

/** One frame's OCR lines -> 'sandbox' | 'academy' | 'staging' | 'both' | 'none'. */
export function classifySwitcherText(lines) {
  const t = (lines ?? []).join(' ');
  if (STAGING_RE.test(t)) return 'staging';
  const hit = Object.entries(PATTERNS).filter(([, p]) => p.name.test(t) && p.id.test(t)).map(([k]) => k);
  return hit.length === 1 ? hit[0] : hit.length > 1 ? 'both' : 'none';
}

/** Decide from per-frame classes. -> {tenant|null, reason} */
export function decideTenant(classes) {
  if (classes.includes('staging')) return { tenant: null, reason: 'recorded_on_staging' };
  const named = classes.filter((c) => c !== 'none');
  if (!named.length) return { tenant: null, reason: 'no_company_visible' };
  if (new Set(named).size > 1 || named.includes('both')) return { tenant: null, reason: 'frames_disagree' };
  if (named.length < MIN_AGREEING_FRAMES) return { tenant: null, reason: 'too_few_frames_show_the_company' };
  return { tenant: named[0], reason: `${named.length}/${classes.length} recorded frames show the ${named[0]} company switcher` };
}

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** Is a stored evidence entry still bound to this script (same recording, same frame files)? Pure. */
export function evidenceMatches(entry, script) {
  if (!entry || entry.method !== METHOD || !['sandbox', 'academy'].includes(entry.tenant)) return false;
  if (!script?.recording?.id || entry.recordingId !== script.recording.id) return false;
  if (!Array.isArray(entry.frames) || entry.frames.length < MIN_AGREEING_FRAMES) return false;
  return entry.frames.every((f) => script.steps?.[f.step]?.media?.pre === f.file) && allOnProductionApp(script);
}

let memo = null;
/** Evidence entries by name ({} when the file is missing/unreadable: unknown stays unknown). */
export function loadTenantEvidence(path = EVIDENCE_PATH) {
  if (memo && memo.path === path) return memo.entries;
  let entries = {};
  try { const o = JSON.parse(readFileSync(path, 'utf8')); if (o?.schema === 1 && o.method === METHOD && o.entries && typeof o.entries === 'object') entries = o.entries; } catch { /* none */ }
  memo = { path, entries };
  return entries;
}
export function clearTenantEvidenceMemo() { memo = null; }

/**
 * Build evidence for scripts. deps: {ocr(paths)->{path:[lines]}, recordingsRoot}. Frames are read from
 * <recordingsRoot>/<recording.id>/<media.pre>. Returns {entries, rejected}.
 */
export function buildTenantEvidence(scripts, { ocr, recordingsRoot = join(REPO, 'out', '_recordings'), now = new Date() } = {}) {
  const work = [], rejected = {};
  for (const s of scripts) {
    if (!s?.name) continue;
    if (!allOnProductionApp(s)) { rejected[s.name] = 'not_all_urls_on_app.hadrius.com'; continue; }
    const recDir = s.recording?.id ? join(recordingsRoot, s.recording.id) : null;
    const frames = [];
    for (let i = 0; i < (s.steps ?? []).length && frames.length < FRAMES_CHECKED; i++) {
      const f = s.steps[i]?.media?.pre;
      if (typeof f === 'string' && /^[\w.-]+\.png$/i.test(f) && recDir && existsSync(join(recDir, f))) frames.push({ step: i, file: f, path: join(recDir, f) });
    }
    if (frames.length < MIN_AGREEING_FRAMES) { rejected[s.name] = 'recorded_frames_missing'; continue; }
    work.push({ script: s, frames });
  }
  const text = work.length ? ocr(work.flatMap((w) => w.frames.map((f) => f.path))) : {};
  const entries = {};
  for (const { script, frames } of work) {
    const classes = frames.map((f) => classifySwitcherText(text[f.path]));
    const d = decideTenant(classes);
    if (!d.tenant) { rejected[script.name] = d.reason; continue; }
    entries[script.name] = {
      tenant: d.tenant, method: METHOD, reason: d.reason, recordingId: script.recording.id, decidedAt: now.toISOString(),
      frames: frames.map((f, i) => ({ step: f.step, file: f.file, sha256: sha256(f.path), class: classes[i], text: (text[f.path] ?? []).slice(0, 8) })),
    };
  }
  return { entries, rejected };
}

export function swiftOcr(paths) {
  return JSON.parse(execFileSync('swift', [join(REPO, 'tools', 'drift', 'ocr-text.swift'), '--roi', SWITCHER_ROI, ...paths], { maxBuffer: 64 * 1024 * 1024, timeout: 900_000 }).toString());
}

export async function main(args = process.argv.slice(2)) {
  const { readLocalScripts, detectScriptTenant } = await import('./tenants.mjs');
  // Only scripts whose URLs name no company are candidates; a URL company always wins.
  const scripts = readLocalScripts().filter((s) => detectScriptTenant(s, { evidence: {} }).status === 'unknown');
  const { entries, rejected } = buildTenantEvidence(scripts, { ocr: swiftOcr });
  const counts = Object.values(entries).reduce((a, e) => { a[e.tenant] = (a[e.tenant] ?? 0) + 1; return a; }, {});
  const rej = Object.values(rejected).reduce((a, r) => { a[r] = (a[r] ?? 0) + 1; return a; }, {});
  if (args.includes('--write')) writeFileSync(EVIDENCE_PATH, JSON.stringify({ schema: 1, method: METHOD, generatedAt: new Date().toISOString(), roi: SWITCHER_ROI, entries, rejected }, null, 2) + '\n');
  console.log(JSON.stringify({ candidates: scripts.length, assigned: counts, rejected: rej, written: args.includes('--write') }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((e) => { console.error(e.message); process.exitCode = 1; });

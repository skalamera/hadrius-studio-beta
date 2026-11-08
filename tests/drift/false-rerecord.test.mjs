// False re-record fixes (tools/drift/disambiguate.mjs, compare.mjs data areas, classify.mjs data drift):
// synthetic frames/signals plus read-only regressions on the real Sandbox run when it exists on this machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { disambiguateTarget, lumaPlane, inkBlobs, findTemplate, rectDistance, normRect } from '../../tools/drift/disambiguate.mjs';
import { classifyStepSignals, videoVerdict, worst, VERDICTS } from '../../tools/drift/classify.mjs';
import { compareImages, decodePng } from '../../tools/drift/compare.mjs';
import { assessVideo } from '../../tools/drift/weekly-submit.mjs';
import { reclassifyRun } from '../../tools/drift/reclassify.mjs';
import { captureRun } from '../../tools/drift/capture.mjs';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { confirmedRelease } from './release-fixture.mjs';

const REPO = new URL('../../', import.meta.url).pathname;
const SBX = join(homedir(), '.hermes', 'cache', 'scratch', 'weekly-20261029-165507-manual');
const RESTORE = 'How-to-restore-an-archived-marketing-project', TEMPLATES = 'How-to-configure-comment-templates-for-document-review', EXPORT = 'How-to-export-marketing-review-data';

// ---------- synthetic frames ----------
const W = 800, H = 400;
const blank = () => { const d = new Uint8Array(W * H * 4).fill(255); return { width: W, height: H, data: d }; };
const fill = (img, x, y, w, h, v = 0) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) { const o = (yy * W + xx) * 4; img.data[o] = img.data[o + 1] = img.data[o + 2] = v; } };
// Deterministic pseudo-"text": a word-like block pattern unique per seed.
const hash = (a, b) => { let h = (a * 2654435761 + b * 40503 + 12345) >>> 0; h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; h ^= h >>> 13; return h >>> 0; };
function text(img, x, y, seed, w = 120) { for (let k = 0; k < w; k += 4) { const s = hash(seed, k); const h = 4 + (s % 9); if (s % 5 !== 0) fill(img, x + k, y + (12 - h), 2 + (s % 2), h); } }
const row = (img, y, seed) => { text(img, 260, y + 8, seed); text(img, 420, y + 8, seed + 100, 80); fill(img, 700, y + 4, 20, 20, 60); }; // name, owner, action icon
const btn = (x, y, w = 40, h = 28, hint = null) => ({ name: 'Restore project', role: 'button', tag: 'button', bbox: { x, y, w, h }, recordHint: hint, visible: true });

test('VERDICTS/worst: unchanged < unchanged_with_data_drift < slide_update', () => {
  assert.deepEqual(VERDICTS.slice(0, 3), ['unchanged', 'unchanged_with_data_drift', 'slide_update']);
  assert.equal(worst(['unchanged_with_data_drift', 'unchanged']), 'unchanged_with_data_drift');
  assert.equal(worst(['unchanged_with_data_drift', 'slide_update']), 'slide_update');
});

test('geometry helpers: viewport normalisation and rect distance', () => {
  assert.deepEqual(normRect({ x: 100, y: 50, w: 10, h: 10 }, { w: 800, h: 450 }, { w: 1600, h: 900 }), { x: 200, y: 100, w: 20, h: 20 });
  assert.equal(rectDistance({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 10 }), 0);
  assert.equal(Math.round(rectDistance({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 72, w: 10, h: 10 })), 72);
});

test('bbox: nearest match with a clear margin is chosen; no margin or no recorded rect stays ambiguous', () => {
  const m = [btn(700, 100), btn(700, 300)];
  const r = disambiguateTarget({ matches: m, recordedRect: { x: 702, y: 101, w: 40, h: 28 } });
  assert.equal(r.status, 'resolved'); assert.equal(r.chosen, 0); assert.equal(r.method, 'bbox');
  assert.equal(r.candidates.length, 2); assert.ok(r.candidates[1].distancePx > 150, 'alternatives are kept as evidence');
  assert.equal(disambiguateTarget({ matches: [btn(700, 100), btn(700, 120)], recordedRect: { x: 700, y: 110, w: 40, h: 28 } }).status, 'ambiguous');
  assert.equal(disambiguateTarget({ matches: m, recordedRect: null }).reason, 'no_recorded_rect');
  assert.equal(disambiguateTarget({ matches: [btn(1, 1)], recordedRect: { x: 1, y: 1, w: 40, h: 28 } }), null, 'one match = nothing to disambiguate');
});

test('record rows: the recorded RECORD is found even when a new record took its position (extra match = data)', () => {
  const rec = blank(); row(rec, 100, 1);                       // recorded: only record #1, at y=100
  const tod = blank(); row(tod, 100, 2); row(tod, 172, 1);      // today: new record #2 on top, #1 pushed down
  const m = [btn(700, 104, 20, 20, { label: 'Record two' }), btn(700, 176, 20, 20, { label: 'Record one' })];
  const r = disambiguateTarget({ matches: m, recordedRect: { x: 700, y: 104, w: 20, h: 20 }, recorded: lumaPlane(rec), today: lumaPlane(tod) });
  assert.equal(r.status, 'resolved'); assert.equal(r.chosen, 1, 'follows the record, not the position'); assert.equal(r.method, 'visual');
  assert.equal(r.reason, 'recorded_area_found_elsewhere');
  assert.equal(r.preexisting, false); assert.equal(r.extraAlternatives, 1); assert.equal(r.extraAreData, true);
  // Without the images a record row is never picked by position (could be someone else's record).
  const noImg = disambiguateTarget({ matches: m, recordedRect: { x: 700, y: 104, w: 20, h: 20 } });
  assert.equal(noImg.status, 'ambiguous'); assert.equal(noImg.reason, 'record_identity_unverifiable');
  const none = blank(); row(none, 100, 3); row(none, 172, 4);  // the recorded record is gone today
  const gone = disambiguateTarget({ matches: m, recordedRect: { x: 700, y: 104, w: 20, h: 20 }, recorded: lumaPlane(rec), today: lumaPlane(none) });
  assert.equal(gone.status, 'ambiguous'); assert.equal(gone.reason, 'record_identity_unclear', 'specific record missing stays a finding');
});

test('a duplicate control that was already on screen when recorded is preexisting, not drift', () => {
  const rec = blank(); fill(rec, 600, 40, 100, 28, 80); fill(rec, 300, 250, 100, 28, 80); text(rec, 20, 40, 7, 200);
  const tod = blank(); fill(tod, 600, 40, 100, 28, 80); fill(tod, 300, 250, 100, 28, 80); text(tod, 20, 40, 7, 200);
  const m = [{ ...btn(600, 40, 100, 28), name: 'Add template' }, { ...btn(300, 250, 100, 28), name: 'Add template' }];
  const r = disambiguateTarget({ matches: m, recordedRect: { x: 600, y: 40, w: 100, h: 28 }, recorded: lumaPlane(rec), today: lumaPlane(tod) });
  assert.equal(r.status, 'resolved'); assert.equal(r.chosen, 0); assert.equal(r.preexisting, true); assert.equal(r.extraAlternatives, 0);
  const tod2 = blank(); fill(tod2, 600, 40, 100, 28, 80); fill(tod2, 300, 250, 100, 28, 80); text(tod2, 20, 40, 7, 200);
  const rec2 = blank(); fill(rec2, 600, 40, 100, 28, 80); text(rec2, 20, 40, 7, 200); // second button is NEW today
  const r2 = disambiguateTarget({ matches: m, recordedRect: { x: 600, y: 40, w: 100, h: 28 }, recorded: lumaPlane(rec2), today: lumaPlane(tod2) });
  assert.equal(r2.preexisting, false); assert.equal(r2.extraAlternatives, 1); assert.equal(r2.extraAreData, false, 'a new non-record control is not data');
});

test('ink blobs + template search find the same text elsewhere', () => {
  const a = blank(); text(a, 300, 100, 5); const b = blank(); text(b, 120, 220, 5);
  const blobs = inkBlobs(lumaPlane(a), { x: 0, y: 90, w: W, h: 30 });
  assert.ok(blobs.length >= 1);
  const f = findTemplate(lumaPlane(a), blobs[0], lumaPlane(b), { x: 0, y: 0, w: W, h: H });
  assert.ok(f.score <= 5, `score ${f.score}`); assert.ok(Math.abs(f.y - blobs[0].y - 120) <= 2);
});

// ---------- classification ----------
const base = { index: 1, action: 'click', narration: 'Click Restore.', hasScreenshot: true, compareClass: 'unchanged', dimensionsMatch: true, targetStatus: 'resolved', targetMethod: 'role_name', targetName: 'Restore project',
  routeChanged: false, flowChanged: false, metrics: { diff: 0, ssimMasked: 1, coverage: 0 }, chromeChanged: false, chromeFraction: 0, judge: null };
const sig = (o) => ({ ...base, ...o, metrics: { ...base.metrics, ...(o.metrics || {}) } });
const accurate = { accurate: true, claim_missing: false, reason: 'ok' };
const uiReleaseEvidence = confirmedRelease();
const chromeRelease = confirmedRelease({ chrome: true });
const resolvedD = (o = {}) => ({ status: 'resolved', chosen: 1, method: 'visual', reason: 'recorded_area_found_elsewhere', candidates: [{ index: 0, recordLabel: 'Test Project 1', presentInRecording: false }, { index: 1, recordLabel: 'Waitlist' }], preexisting: false, extraAlternatives: 1, extraAreData: true, ...o });

test('ambiguity resolved by disambiguation never yields full_rerecord on its own', () => {
  const r = classifyStepSignals(sig({ disambiguation: resolvedD({ method: 'visual+bbox', preexisting: true, extraAlternatives: 0, extraAreData: null }) }));
  assert.equal(r.verdict, 'unchanged'); assert.ok(r.reasons.some((x) => x.code === 'target_disambiguated')); assert.ok(r.reasons.some((x) => x.code === 'ambiguity_preexisting'));
  const r2 = classifyStepSignals(sig({ disambiguation: resolvedD() }));
  assert.equal(r2.verdict, 'unchanged_with_data_drift'); assert.ok(r2.reasons.some((x) => x.code === 'extra_record_matches'));
  // record moved because of the extra record: data, not a moved highlight
  const r3 = classifyStepSignals(sig({ disambiguation: resolvedD(), compareClass: 'target_geometry_changed', targetDeltaMax: 72, targetIsRecord: true, judge: accurate, metrics: { diff: 0.003, ssimMasked: 0.97 } }));
  assert.ok(r3.reasons.some((x) => x.code === 'target_moved_with_data')); assert.ok(!r3.reasons.some((x) => x.code === 'target_moved'));
  assert.notEqual(r3.verdict, 'full_rerecord');
});

test('unresolved targets are unverified without confirmation; route change / contradicted narration remain full_rerecord', () => {
  assert.equal(classifyStepSignals(sig({ targetStatus: 'ambiguous', targetMatches: 2, compareClass: 'target_missing', disambiguation: { status: 'ambiguous', reason: 'record_identity_unclear', candidates: [] } })).verdict, 'unverified');
  assert.equal(classifyStepSignals(sig({ targetStatus: 'missing', compareClass: 'target_missing' })).verdict, 'unverified');
  assert.equal(classifyStepSignals(sig({ routeChanged: true, recordedPath: '/a', todayPath: '/b' })).verdict, 'full_rerecord');
  assert.equal(classifyStepSignals(sig({ compareClass: 'screenshot_changed', metrics: { diff: 0.01, ssimMasked: 0.95 }, judge: { accurate: false, claim_missing: true, reason: 'gone' } })).verdict, 'full_rerecord');
  assert.equal(classifyStepSignals(sig({ compareClass: 'screenshot_changed', metrics: { diff: 0.3, ssimMasked: 0.6, coverage: 0.7 }, judge: accurate, uiReleaseEvidence })).verdict, 'full_rerecord', 'real redesign with production UI-code evidence');
});

test('data-only screenshot change = unchanged_with_data_drift (no judge); UI change outside data areas stays slide_update', () => {
  const d = sig({ action: 'navigate', compareClass: 'screenshot_changed', dataOnly: true, dataChangedPixels: 5000, metrics: { diff: 0.03, ssimMasked: 0.9, coverage: 0.3, diffUi: 0.0005, ssimUi: 0.995, coverageUi: 0.01 } });
  const r = classifyStepSignals(d); assert.equal(r.verdict, 'unchanged_with_data_drift'); assert.equal(r.needsJudge, false); assert.ok(r.reasons.some((x) => x.code === 'data_only_change'));
  assert.equal(classifyStepSignals({ ...d, dataOnly: false, judge: accurate, uiReleaseEvidence }).verdict, 'slide_update');
  assert.equal(classifyStepSignals({ ...d, chromeChanged: true, chromeFraction: 0.5, judge: accurate, uiReleaseEvidence: chromeRelease }).verdict, 'slide_update', 'sidebar change with production UI-code evidence');
  // many records changed (full-frame metrics look like a redesign) but UI-only metrics are calm: not a redesign
  const big = sig({ action: 'navigate', compareClass: 'screenshot_changed', dataOnly: true, metrics: { diff: 0.25, ssimMasked: 0.6, coverage: 0.8, diffUi: 0.001, ssimUi: 0.99, coverageUi: 0.02 } });
  assert.equal(classifyStepSignals(big).verdict, 'unchanged_with_data_drift');
  // a real redesign outside the data areas is still caught by the UI-only metrics
  const red = sig({ action: 'navigate', compareClass: 'screenshot_changed', dataOnly: false, judge: accurate, uiReleaseEvidence, metrics: { diff: 0.3, ssimMasked: 0.6, coverage: 0.8, diffUi: 0.2, ssimUi: 0.7, coverageUi: 0.6 } });
  assert.equal(classifyStepSignals(red).verdict, 'full_rerecord');
});

test('video: data-drift slides count as kept for the mixed old/new UI rule; data drift alone is not posted', () => {
  const steps = [{ index: 0, verdict: 'unchanged_with_data_drift', reasons: [{ verdict: 'unchanged_with_data_drift', code: 'data_only_change', detail: 'x' }], chromeChanged: false },
    { index: 1, verdict: 'unchanged', reasons: [], chromeChanged: false }];
  const v = videoVerdict(steps); assert.equal(v.verdict, 'unchanged_with_data_drift'); assert.match(v.summary, /only shared-tenant data differs/);
  const mixed = videoVerdict([{ ...steps[0] }, { index: 1, verdict: 'slide_update', reasons: [{ verdict: 'slide_update', code: 'persistent_chrome_changed', detail: 'x' }], chromeChanged: true, uiReleaseEvidence: chromeRelease }]);
  assert.equal(mixed.verdict, 'full_rerecord'); assert.ok(mixed.reasons.some((r) => r.code === 'mixed_old_new_ui'));
  const a = assessVideo({ status: 'ok', verdict: 'unchanged_with_data_drift', complete: true, steps });
  assert.equal(a.decision, 'skip'); assert.equal(a.reason, 'data_drift_only');
});

test('compareImages: changes only inside data rects are dataOnly; a change outside is UI', () => {
  const a = blank(); row(a, 100, 1); const b = blank(); row(b, 100, 1); row(b, 172, 2);
  const dataRects = [{ x: 240, y: 90, w: 560, h: 140, kind: 'list' }];
  const c = compareImages(a, b, { dataRects });
  assert.equal(c.classification, 'screenshot_changed'); assert.equal(c.dataOnly, true); assert.ok(c.dataChangedPixels > 0); assert.equal(c.diffFractionUi, 0);
  assert.ok(c.regions.every((r) => r.data || r.dynamic));
  fill(b, 10, 10, 60, 40, 0); // UI change (e.g. sidebar) outside the data area
  const c2 = compareImages(a, b, { dataRects });
  assert.equal(c2.dataOnly, false); assert.ok(c2.diffFractionUi > 0.002);
  assert.equal(compareImages(a, b).dataOnly, undefined, 'without data rects nothing is classed as data');
});

// ---------- real Sandbox evidence (read-only; skipped when not on this machine) ----------
const haveReal = existsSync(join(SBX, RESTORE, 'capture', 'run.json')) && existsSync(join(REPO, 'scripts', `${RESTORE}.script.json`));
const realCase = (name, step) => {
  const run = JSON.parse(readFileSync(join(SBX, name, 'capture', 'run.json'), 'utf8'));
  const sc = JSON.parse(readFileSync(join(REPO, 'scripts', `${name}.script.json`), 'utf8'));
  const s = run.steps.find((x) => x.index === step), st = sc.steps.find((x) => x.index === step);
  const rec = lumaPlane(decodePng(readFileSync(join(REPO, 'out', '_recordings', sc.recording.id, st.media.pre))));
  const tod = lumaPlane(decodePng(readFileSync(join(SBX, name, 'capture', s.screenshot))));
  return disambiguateTarget({ matches: s.target.matches, recordedRect: s.target.recordedRect, recordedViewport: st.target.hint?.viewport ?? st.target.viewport, recorded: rec, today: tod });
};
test('real Sandbox: "Restore project" (2 archived projects today, 1 recorded) resolves to the recorded record; the other is new data', { skip: !haveReal }, () => {
  const r = realCase(RESTORE, 1);
  assert.equal(r.status, 'resolved'); assert.match(r.candidates[r.chosen].recordLabel, /^Waitlist Nurture Email Sequence/);
  assert.equal(r.extraAreData, true); assert.equal(r.preexisting, false);
});
test('real Sandbox: "Add template" (header + empty state, both already recorded) resolves to the header button, preexisting', { skip: !haveReal }, () => {
  const r = realCase(TEMPLATES, 1);
  assert.equal(r.status, 'resolved'); assert.equal(r.chosen, 0); assert.deepEqual(r.candidates[0].bbox, { x: 1425, y: 182, w: 109, h: 36 });
  assert.equal(r.preexisting, true);
});
test('real Sandbox run re-classified offline: data-only cases are not redesigns; UI pixels stay unverified without release evidence', { skip: !haveReal }, async () => {
  const rep = await reclassifyRun({ runDir: SBX, write: false });
  const by = Object.fromEntries(rep.videos.map((v) => [v.name, v]));
  assert.equal(by[RESTORE].before, 'full_rerecord'); assert.notEqual(by[RESTORE].after, 'full_rerecord');
  assert.equal(by[TEMPLATES].before, 'full_rerecord'); assert.notEqual(by[TEMPLATES].after, 'full_rerecord');
  assert.notEqual(by[EXPORT].after, 'full_rerecord', 'pixels alone cannot confirm the export-filter redesign');
  assert.ok(by[EXPORT].steps.some((s) => s.codes.some((c) => c.startsWith('unverified:') && c.includes('release_unconfirmed'))),'the redesign remains explicitly unverified pending production code corroboration');
  assert.ok(by[RESTORE].steps[1].codes.includes('unchanged_with_data_drift:extra_record_matches'));
});

// ---------- capture-time disambiguation (fake browser, no network) ----------
function fakeChromium(cands) {
  const actions = [];
  const mk = () => { let url = 'about:blank'; return {
    url: () => url, goto: async (u) => { url = u; }, waitForURL: async () => {}, waitForTimeout: async () => {}, waitForLoadState: async () => {}, setViewportSize: async () => {}, on: () => {},
    title: async () => 'T', screenshot: async ({ path }) => { writeFileSync(path, 'not-a-png'); }, keyboard: { press: async () => {} },
    evaluate: async (expr) => { const e = String(expr); if (e.includes('aria-busy')) return false; if (e.includes('hasPassword')) return { url, hasPassword: false, hasAppNav: true, academy: true, title: 'T' };
      if (e.includes('__driftCandidates')) return cands.map((c, i) => ({ i, visible: true, cssMatch: false, href: null, ...c })); return []; },
    evaluateHandle: async (_f, i) => { const c = cands[i]; return { evaluate: async () => ({ name: c.name, href: null }), click: async () => actions.push(['click', i]), hover: async () => {}, focus: async () => {} }; },
  }; };
  return { actions, launchPersistentContext: async () => { const p = mk(); return { route: async () => {}, pages: () => [p], newPage: async () => p, close: async () => {} }; } };
}
async function captureWith(cands, target) {
  const dir = mkdtempSync(join(tmpdir(), 'drift-dis-')); const prof = join(dir, '.browser-profile-drift'); mkdirSync(prof);
  const L = 'https://app.hadrius.com/settings?company_id=1150';
  const script = { name: 'f', environment: { startUrl: L }, recording: { id: 'r' }, steps: [{ index: 0, action: 'click', url: L, route: '/settings?company_id=1150', media: { pre: 'a.png' }, target }] };
  const sp = join(dir, 's.json'); writeFileSync(sp, JSON.stringify(script));
  const fc = fakeChromium(cands); const orig = globalThis.fetch; globalThis.fetch = async () => ({ json: async () => ({ running: false }) });
  try { const run = await captureRun({ scriptPath: sp, profileDir: prof, outDir: join(dir, 'run'), log: () => {}, chromium: fc, ensureSession: async () => ({ status: 'already_signed_in', companyIds: [1150] }), limits: { stepMs: 5000, totalMs: 30000, settleMs: 0, idleMs: 0, manualLoginMs: 0, loadingWaitMs: 0 } });
    return { run, actions: fc.actions }; } finally { globalThis.fetch = orig; }
}
test('captureRun: two same-name controls -> the one at the recorded rect is chosen (evidence kept) and replayed', async () => {
  const { run, actions } = await captureWith([{ role: 'button', tag: 'button', name: 'Open panel', bbox: { x: 1400, y: 180, w: 100, h: 36 } }, { role: 'button', tag: 'button', name: 'Open panel', bbox: { x: 800, y: 430, w: 100, h: 36 } }],
    { role: 'button', tag: 'button', name: 'Open panel', bbox: { x: 1400, y: 180, w: 100, h: 36 }, viewport: { w: 1600, h: 900 } });
  const t = run.steps[0].target;
  assert.equal(t.status, 'resolved'); assert.equal(t.disambiguation.method, 'bbox'); assert.equal(t.disambiguation.candidates.length, 2); assert.equal(t.ambiguousMatches, 2);
  assert.deepEqual(actions, [['click', 0]], 'only the recorded one is clicked');
});
test('captureRun: same-name record rows without the recorded frame stay ambiguous and are never clicked', async () => {
  const { run, actions } = await captureWith([{ role: 'button', tag: 'button', name: 'Open record', bbox: { x: 1400, y: 280, w: 40, h: 32 }, recordHint: { label: 'A' } }, { role: 'button', tag: 'button', name: 'Open record', bbox: { x: 1400, y: 352, w: 40, h: 32 }, recordHint: { label: 'B' } }],
    { role: 'button', tag: 'button', name: 'Open record', bbox: { x: 1400, y: 280, w: 40, h: 32 } });
  assert.equal(run.steps[0].target.status, 'ambiguous'); assert.equal(run.steps[0].target.disambiguation.reason, 'record_identity_unverifiable');
  assert.deepEqual(actions, []);
});

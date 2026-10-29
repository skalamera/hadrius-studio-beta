// Weekly run -> drift job submission (tools/drift/weekly-submit.mjs): filtering, account-visibility blocking,
// payload building, stable fingerprints and dedupe. Pure: synthetic job.json objects, no network, no bridge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assessVideo, proposedNarrationOf, durationsFrom, buildPayload, prepareSubmissions, dedupeAgainst, humanSummary, blocksToText, BLOCKED_ACCOUNT_LABEL } from '../../tools/drift/weekly-submit.mjs';
import { buildDriftMessage } from '../../tools/drift/slack.mjs';

const R = (verdict, code, detail = 'd') => ({ verdict, code, detail });
const step = (index, verdict, reasons = [], extra = {}) => ({ index, action: index ? 'click' : 'navigate', verdict, reasons, evidence: { recorded: `/rec/s${index}.png`, today: `/run/s${index}.png` }, ...extra });
const script = (n = 3) => ({ name: 'Vid', title: 'Video', module: 'Marketing', driveVideoId: 'DRIVE1', pylonArticleId: 'P1', steps: Array.from({ length: n }, (_, i) => ({ index: i, narration: `line ${i}` })) });
const job = (over = {}) => ({ name: 'Vid', status: 'ok', verdict: 'slide_update', complete: true, summary: 's', reasons: [], steps: [step(0, 'slide_update', [R('slide_update', 'screenshot_changed', 'diff 3% non-dynamic, SSIM 0.9')]), step(1, 'unchanged'), step(2, 'unchanged')], ...over });

test('assessVideo: account-only symptoms are blocked, not posted', () => {
  const j = job({ verdict: 'unchanged', complete: false, steps: [step(0, 'unchanged'), step(1, 'unverified', [R('unverified', 'record_not_visible')]), step(2, 'unverified', [R('unverified', 'page_not_loaded')])] });
  const a = assessVideo(j);
  assert.equal(a.decision, 'blocked_account_visibility'); assert.equal(a.reason, BLOCKED_ACCOUNT_LABEL); assert.deepEqual(a.accountSteps, [1, 2]);
  // data_missing / page_error count too
  assert.equal(assessVideo(job({ verdict: 'unchanged', complete: false, steps: [step(0, 'unverified', [R('unverified', 'data_missing')]), step(1, 'unverified', [R('unverified', 'page_error')])] })).decision, 'blocked_account_visibility');
});
test('assessVideo: real UI change is posted; chrome change on unverified slides counts as UI evidence', () => {
  assert.equal(assessVideo(job()).decision, 'post');
  const flags = job({ verdict: 'full_rerecord', complete: false, reasons: [{ step: null, verdict: 'full_rerecord', code: 'mixed_old_new_ui', detail: 'x' }],
    steps: [0, 1].map((i) => step(i, 'unverified', [R('unverified', 'data_missing')], { chromeChanged: true })) });
  const a = assessVideo(flags);
  assert.equal(a.decision, 'post'); assert.deepEqual(a.chromeOnlySteps, [0, 1]); assert.deepEqual(a.accountSteps, [0, 1]);
  assert.equal(a.verdictMayChangeWithAccess, true);
});
test('assessVideo: unchanged / failed captures / needs_fixture-only are skipped', () => {
  assert.deepEqual([assessVideo(job({ verdict: 'unchanged', steps: [step(0, 'unchanged')] })).decision, assessVideo(job({ verdict: 'unchanged', steps: [step(0, 'unchanged')] })).reason], ['skip', 'unchanged']);
  assert.equal(assessVideo(job({ status: 'capture_failed', verdict: null })).reason, 'no_verdict:capture_failed');
  assert.equal(assessVideo(null).reason, 'no_verdict:missing_job');
  const nf = assessVideo(job({ verdict: 'unchanged', complete: false, steps: [step(0, 'unchanged'), step(1, 'unverified', [R('unverified', 'needs_fixture')])] }));
  assert.deepEqual([nf.decision, nf.reason], ['skip', 'unchanged_partially_verified']);
});
test('assessVideo: a change verdict backed only by account codes is not UI evidence', () => {
  const j = job({ verdict: 'full_rerecord', steps: [step(0, 'full_rerecord', [R('unverified', 'data_missing')]), step(1, 'unverified', [R('unverified', 'page_not_loaded')])] });
  assert.equal(assessVideo(j).decision, 'blocked_account_visibility');
});

test('proposedNarrationOf: only narration_inaccurate rewrites, never data_missing/claim_missing', () => {
  const j = job({ steps: [
    step(0, 'narration_review', [R('narration_review', 'narration_inaccurate')], { judge: { accurate: false, suggested_rewrite: 'new 0' } }),
    step(1, 'unverified', [R('unverified', 'data_missing')], { judge: { accurate: false, data_missing: true, suggested_rewrite: 'nope' } }),
    step(2, 'full_rerecord', [R('full_rerecord', 'narration_contradicted')], { judge: { accurate: false, claim_missing: true, suggested_rewrite: 'nope' } }),
  ] });
  assert.deepEqual(proposedNarrationOf(j), { 0: 'new 0' });
});
test('durationsFrom maps assembly slides onto script steps', () => {
  assert.deepEqual(durationsFrom({ duration: 27, slides: [{ step: 0, sdur: 5.8 }, { step: 2, sdur: 4 }] }, script()), { slideDurations: [5.8, 0, 4], oldDurationSec: 27 });
  assert.equal(durationsFrom({ duration: 27, slides: [{ step: 9, sdur: 1 }] }, script()).slideDurations, null);
  assert.equal(durationsFrom(null, script()).slideDurations, null);
});

test('buildPayload: links, durations, proposed narration -> auto_update with stable fingerprint', () => {
  const j = job({ verdict: 'narration_review', steps: [step(0, 'narration_review', [R('narration_review', 'narration_inaccurate', 'wrong')], { judge: { accurate: false, suggested_rewrite: 'Rewrite A' } }), step(1, 'unchanged'), step(2, 'unchanged')] });
  const p = buildPayload({ job: j, script: script(), assembly: { duration: 30, slides: [{ step: 0, sdur: 10 }, { step: 1, sdur: 10 }, { step: 2, sdur: 10 }] }, pylonUrl: ({ id }) => `https://pylon.example/${id}` });
  assert.equal(p.kind, 'auto_update');
  assert.equal(p.details.links.drive, 'https://drive.google.com/file/d/DRIVE1/view'); assert.equal(p.details.links.pylon, 'https://pylon.example/P1');
  assert.equal(p.details.changes[0].newNarration, 'Rewrite A'); assert.equal(p.details.untouched.framesPreservedPct, 66.7); assert.equal(p.details.untouched.oldDurationSec, 30);
  // The judge rewords its suggestion every run: the fingerprint must not change.
  const j2 = structuredClone(j); j2.steps[0].judge.suggested_rewrite = 'Rewrite B, worded differently';
  assert.equal(buildPayload({ job: j2, script: script() }).fingerprint, p.fingerprint);
  // ...but a different change does.
  assert.notEqual(buildPayload({ job: job(), script: script() }).fingerprint, p.fingerprint);
  // Run paths don't matter either.
  const j3 = structuredClone(job()); j3.steps[0].evidence.today = '/other-run/s0.png';
  assert.equal(buildPayload({ job: j3, script: script() }).fingerprint, buildPayload({ job: job(), script: script() }).fingerprint);
});
test('buildPayload: chrome-only slides become evidence steps; account note added; manual_rerecord', () => {
  const j = job({ verdict: 'full_rerecord', complete: false, reasons: [{ step: null, verdict: 'full_rerecord', code: 'mixed_old_new_ui', detail: 'sidebar changed' }],
    steps: [step(0, 'unverified', [R('unverified', 'data_missing')], { chromeChanged: true }), step(1, 'unverified', [R('unverified', 'page_not_loaded')], { chromeChanged: true }), step(2, 'unchanged')] });
  const p = buildPayload({ job: j, script: script() });
  assert.equal(p.kind, 'manual_rerecord');
  assert.deepEqual(p.details.changes.map((c) => [c.step, c.reasonCodes[0]]), [[1, 'persistent_chrome_changed'], [2, 'persistent_chrome_changed']]);
  assert.equal(p.details.changes[0].after.path, '/run/s0.png');
  assert.deepEqual(p.details.accountLimited, { steps: [1, 2], verdictMayChangeWithAccess: true });
  assert.ok(p.details.reasons.some((r) => /automation account can't see/.test(r)));
  const acc = buildPayload({ job: job({ verdict: 'full_rerecord', steps: [step(0, 'full_rerecord', [R('full_rerecord', 'page_redesigned', 'SSIM 0.7'), R('unverified', 'data_missing', 'queue empty')])] }), script: script(1) });
  assert.deepEqual(acc.details.changes[0].why.map((w) => /^Not UI drift/.test(w)), [false, true]);
  const msg = buildDriftMessage({ id: 'x', ...p });
  assert.ok(msg.blocks.length <= 50); assert.match(blocksToText(msg), /Needs a re-record/);
});

function runIo(jobs, scripts = { Vid: script() }) {
  return { readJson: (p) => jobs[p.split('/').at(-2)] ?? null, readScript: (n) => scripts[n] ?? null, readAssembly: () => null };
}
test('prepareSubmissions: per-video decisions, names filter, missing script, PR links', () => {
  const summary = { videos: [{ name: 'Vid' }, { name: 'Blocked' }, { name: 'Same' }, { name: 'NoScript' }, { name: 'Vid' }] };
  const jobs = { Vid: job(), Blocked: job({ name: 'Blocked', verdict: 'unchanged', complete: false, steps: [step(0, 'unverified', [R('unverified', 'record_not_visible')])] }),
    Same: job({ name: 'Same', verdict: 'unchanged', steps: [step(0, 'unchanged')] }), NoScript: job({ name: 'NoScript' }) };
  const rows = prepareSubmissions({ summary, runDir: '/r', io: runIo(jobs), prsByName: { Vid: [{ number: 7, title: 'Rename', url: 'https://github.com/x/pull/7' }] } });
  assert.deepEqual(rows.map((r) => [r.name, r.decision]), [['Vid', 'post'], ['Blocked', 'blocked_account_visibility'], ['Same', 'skip'], ['NoScript', 'skip']]);
  assert.equal(rows[0].payload.details.detection.source, 'merged_prs+recapture'); assert.equal(rows[0].payload.details.detection.prs[0].number, 7);
  assert.equal(rows[3].reason, 'script_not_found');
  assert.deepEqual(prepareSubmissions({ summary, runDir: '/r', names: ['Blocked'], io: runIo(jobs) }).map((r) => r.name), ['Blocked']);
  const md = humanSummary(rows, { runDir: '/r', dryRun: true });
  assert.match(md, /WOULD POST as auto_update/); assert.match(md, new RegExp(BLOCKED_ACCOUNT_LABEL)); assert.match(md, /missing record access/);
});
test('dedupeAgainst: same fingerprint (open or declined) and any open job for the video are not re-posted', () => {
  const mk = () => prepareSubmissions({ summary: { videos: [{ name: 'Vid' }] }, runDir: '/r', io: runIo({ Vid: job() }) });
  const fp = mk()[0].payload.fingerprint;
  assert.equal(dedupeAgainst(mk(), [{ id: 'a', video_name: 'Vid', fingerprint: fp, status: 'denied' }])[0].decision, 'duplicate');
  assert.equal(dedupeAgainst(mk(), [{ id: 'b', video_name: 'Vid', fingerprint: 'fp1-old', status: 'pending_approval' }])[0].decision, 'duplicate');
  assert.equal(dedupeAgainst(mk(), [{ id: 'c', video_name: 'Vid', fingerprint: 'fp1-old', status: 'published' }])[0].decision, 'post');
  assert.equal(dedupeAgainst(mk(), [{ id: 'd', video_name: 'Other', fingerprint: fp, status: 'pending_approval' }])[0].decision, 'post');
});

// Regression on the real 2026-10-29 live run when it exists on this machine (read-only).
const LIVE = join(homedir(), '.hermes', 'cache', 'scratch', 'weekly-20261029-063944');
test('real run 2026-10-29: View-Flags is posted only because of the sidebar change, and flagged as account-limited', { skip: !existsSync(LIVE) }, () => {
  const j = JSON.parse(readFileSync(join(LIVE, 'How-to-View-Flags', 'job.json'), 'utf8'));
  const a = assessVideo(j);
  assert.equal(a.decision, 'post'); assert.deepEqual(a.accountSteps, [0, 1, 2, 3, 4]); assert.equal(a.verdictMayChangeWithAccess, true);
  assert.equal(assessVideo(JSON.parse(readFileSync(join(LIVE, 'How-to-archive-a-policy', 'job.json'), 'utf8'))).decision, 'skip');
});

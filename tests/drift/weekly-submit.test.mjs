// Weekly run -> drift job submission (tools/drift/weekly-submit.mjs): filtering, account-visibility blocking,
// payload building, stable fingerprints and dedupe. Pure: synthetic job.json objects, no network, no bridge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assessVideo, proposedNarrationOf, durationsFrom, buildPayload, prepareSubmissions, dedupeAgainst, humanSummary, blocksToText, BLOCKED_ACCOUNT_LABEL } from '../../tools/drift/weekly-submit.mjs';
import { buildDriftMessage } from '../../tools/drift/slack.mjs';
import { confirmedRelease } from './release-fixture.mjs';
import { selectWeeklyJobs, selectionMarker } from '../../tools/drift/ui-selection.mjs';

const R = (verdict, code, detail = 'd') => ({ verdict, code, detail });
const step = (index, verdict, reasons = [], extra = {}) => ({ index, action: index ? 'click' : 'navigate', verdict, reasons, evidence: { recorded: `/rec/s${index}.png`, today: `/run/s${index}.png` }, ...extra });
const script = (n = 3) => ({ name: 'Vid', title: 'Video', module: 'Marketing', driveVideoId: 'DRIVE1', pylonArticleId: 'P1', steps: Array.from({ length: n }, (_, i) => ({ index: i, narration: `line ${i}` })) });
const job = (over = {}) => ({ name: 'Vid', status: 'ok', verdict: 'slide_update', complete: true, summary: 's', reasons: [], steps: [step(0, 'slide_update', [R('slide_update', 'screenshot_changed', 'diff 3% non-dynamic, SSIM 0.9')]), step(1, 'unchanged'), step(2, 'unchanged')], ...over });
const release = confirmedRelease();
const chromeRelease = confirmedRelease({ chrome: true });
const redesignJob = (name = 'Vid') => job({ name, verdict: 'full_rerecord', steps: [step(0, 'full_rerecord', [R('full_rerecord', 'page_redesigned', 'SSIM 0.7')], { uiReleaseEvidence: release }), step(1, 'unchanged'), step(2, 'unchanged')] });
const batchAssessment = (j) => assessVideo(j, { selection: selectWeeklyJobs([j], { readScript: () => script() }).byName.get(j.name) });

test('assessVideo: account-only symptoms are blocked, not posted', () => {
  const j = job({ verdict: 'unchanged', complete: false, steps: [step(0, 'unchanged'), step(1, 'unverified', [R('unverified', 'record_not_visible')]), step(2, 'unverified', [R('unverified', 'page_not_loaded')])] });
  const a = assessVideo(j);
  assert.equal(a.decision, 'blocked_account_visibility'); assert.equal(a.reason, BLOCKED_ACCOUNT_LABEL); assert.deepEqual(a.accountSteps, [1, 2]);
  // data_missing / page_error count too
  assert.equal(assessVideo(job({ verdict: 'unchanged', complete: false, steps: [step(0, 'unverified', [R('unverified', 'data_missing')]), step(1, 'unverified', [R('unverified', 'page_error')])] })).decision, 'blocked_account_visibility');
});
test('assessVideo: only a verified UI redesign with matching production UI-code evidence is posted', () => {
  assert.deepEqual([assessVideo(job()).decision, assessVideo(job()).reason], ['skip', 'no_release_confirmed_ui_redesign']);
  assert.equal(batchAssessment(redesignJob()).decision, 'post');
  const screenshotOnly = job({ steps: [step(0, 'slide_update', [R('slide_update', 'screenshot_changed')], { uiReleaseEvidence: release })] });
  assert.deepEqual([assessVideo(screenshotOnly).decision, assessVideo(screenshotOnly).reason], ['skip', 'no_release_confirmed_ui_redesign']);
  const flags = job({ verdict: 'full_rerecord', complete: false, reasons: [{ step: null, verdict: 'full_rerecord', code: 'mixed_old_new_ui', detail: 'x' }],
    steps: [step(0, 'slide_update', [R('slide_update', 'persistent_chrome_changed')], { chromeChanged: true, uiReleaseEvidence: chromeRelease }),
      step(1, 'unverified', [R('unverified', 'data_missing')]), step(2, 'unverified', [R('unverified', 'page_not_loaded')])] });
  const a = batchAssessment(flags);
  assert.equal(a.decision, 'post'); assert.deepEqual(a.uiEvidenceSteps, [0]); assert.deepEqual(a.chromeOnlySteps, []); assert.deepEqual(a.accountSteps, [1, 2]);
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
test('empty or missing data without release-confirmed UI evidence is skipped, not treated as a redesign', () => {
  const j = job({ verdict: 'unchanged', complete: false, steps: [step(0, 'unverified', [R('unverified', 'empty_state_data_unverified')])] });
  assert.deepEqual([assessVideo(j).decision, assessVideo(j).reason], ['skip', 'empty_or_missing_data_unverified']);
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

test('buildPayload: selected UI-only scope preserves links/durations; unrelated narration never enters weekly payloads', () => {
  const j = job({ steps: [step(0, 'slide_update', [R('slide_update', 'ui_changed')], { uiReleaseEvidence: release, judge: { accurate: false, suggested_rewrite: 'Rewrite A' } }), step(1, 'unchanged'), step(2, 'unchanged')] });
  const payload = (j, options = {}) => buildPayload({ job: j, script: script(), assessment: batchAssessment(j), ...options });
  const p = payload(j, { assembly: { duration: 30, slides: [{ step: 0, sdur: 10 }, { step: 1, sdur: 10 }, { step: 2, sdur: 10 }] }, pylonUrl: ({ id }) => `https://pylon.example/${id}` });
  assert.equal(p.kind, 'auto_update');
  assert.equal(p.details.links.drive, 'https://drive.google.com/file/d/DRIVE1/view'); assert.equal(p.details.links.pylon, 'https://pylon.example/P1');
  assert.equal(p.details.changes[0].newNarration, null); assert.equal(p.details.untouched.framesPreservedPct, 66.7); assert.equal(p.details.untouched.oldDurationSec, 30);
  // The judge rewords its suggestion every run: the fingerprint must not change.
  const j2 = structuredClone(j); j2.steps[0].judge.suggested_rewrite = 'Rewrite B, worded differently';
  assert.equal(payload(j2).fingerprint, p.fingerprint);
  // ...but a different change does.
  assert.throws(() => buildPayload({ job: job(), script: script() }), /weekly_selection_required/);
  // Run paths don't matter either.
  const j3 = structuredClone(j); j3.steps[0].evidence.today = '/other-run/s0.png';
  assert.equal(payload(j3).fingerprint, p.fingerprint);
});
test('buildPayload: chrome-only slides become evidence steps; account note added; manual_rerecord', () => {
  const j = job({ verdict: 'full_rerecord', complete: false, reasons: [{ step: null, verdict: 'full_rerecord', code: 'mixed_old_new_ui', detail: 'sidebar changed' }],
    steps: [step(0, 'slide_update', [R('slide_update', 'persistent_chrome_changed')], { chromeChanged: true, uiReleaseEvidence: chromeRelease }), step(1, 'unverified', [R('unverified', 'page_not_loaded')]), step(2, 'unchanged')] });
  const p = buildPayload({ job: j, script: script(), assessment: batchAssessment(j) });
  assert.equal(p.kind, 'manual_rerecord');
  assert.deepEqual(p.details.changes.map((c) => [c.step, c.reasonCodes[0]]), [[1, 'persistent_chrome_changed']]);
  assert.equal(p.details.changes[0].after.path, '/run/s0.png');
  assert.deepEqual(p.details.accountLimited, { steps: [2], verdictMayChangeWithAccess: true });
  assert.ok(p.details.reasons.some((r) => /automation account can't see/.test(r)));
  assert.throws(() => buildPayload({ job: job({ verdict: 'full_rerecord', steps: [step(0, 'full_rerecord', [R('full_rerecord', 'page_redesigned'), R('unverified', 'data_missing')])] }), script: script(1) }), /weekly_selection_required/);
  const msg = buildDriftMessage({ id: 'x', ...p });
  assert.ok(msg.blocks.length <= 50); assert.match(blocksToText(msg), /Needs a re-record/);
});

function runIo(jobs, scripts = { Vid: script() }) {
  return { readJson: (p) => jobs[p.split('/').at(-2)] ?? null, readScript: (n) => scripts[n] ?? null, readAssembly: () => null };
}
function finalized(summary,io){
  const jobs=[...new Set(summary.videos.map(v=>v.name))].map(name=>({...io.readJson(`/r/${name}/job.json`),name}));
  return {...summary,uiSelection:selectionMarker(selectWeeklyJobs(jobs,{readScript:io.readScript}))};
}
test('prepareSubmissions: only release-confirmed redesigns post; other decisions remain blocked or skipped', () => {
  const summary = { finishedAt: '2026-10-31T20:00:00Z', videos: [{ name: 'Vid' }, { name: 'Blocked' }, { name: 'Same' }, { name: 'NoScript' }, { name: 'Vid' }] };
  const jobs = { Vid: redesignJob(), Blocked: job({ name: 'Blocked', verdict: 'unchanged', complete: false, steps: [step(0, 'unverified', [R('unverified', 'record_not_visible')])] }),
    Same: job({ name: 'Same', verdict: 'unchanged', steps: [step(0, 'unchanged')] }), NoScript: redesignJob('NoScript') };
  const io=runIo(jobs),completed=finalized(summary,io);
  const rows = prepareSubmissions({ summary:completed, runDir: '/r', io, prsByName: { Vid: [{ number: 7, title: 'Rename', url: 'https://github.com/x/pull/7' }] } });
  assert.deepEqual(rows.map((r) => [r.name, r.decision]), [['Vid', 'post'], ['Blocked', 'blocked_account_visibility'], ['Same', 'skip'], ['NoScript', 'skip']]);
  assert.equal(rows[0].payload.details.detection.source, 'production_release_diff+recapture'); assert.deepEqual(rows[0].payload.details.detection.prs, []);
  const evidenceText = blocksToText(buildDriftMessage({ id: 'x', ...rows[0].payload }));
  assert.match(evidenceText, /Production release/); assert.match(evidenceText, /renamed “Create rule” → “New rule”/); assert.doesNotMatch(evidenceText, /Rename/);
  assert.equal(rows[3].reason, 'selection_context_missing');
  assert.deepEqual(prepareSubmissions({ summary:completed, runDir: '/r', names: ['Blocked'], io }).map((r) => r.name), ['Blocked']);
  const md = humanSummary(rows, { runDir: '/r', dryRun: true });
  assert.match(md, /WOULD POST as manual_rerecord/); assert.match(md, new RegExp(BLOCKED_ACCOUNT_LABEL)); assert.match(md, /missing record access/);
});
test('dedupeAgainst: same fingerprint (open or declined) and any open job for the video are not re-posted', () => {
  const mk = () => {const io=runIo({Vid:redesignJob()});return prepareSubmissions({ summary:finalized({ finishedAt:'2026-10-31T20:00:00Z',videos:[{name:'Vid'}]},io),runDir:'/r',io });};
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
  assert.equal(a.decision, 'blocked_account_visibility'); assert.deepEqual(a.accountSteps, [0, 1, 2, 3, 4]); assert.equal(a.uiEvidenceSteps.length, 0);
  assert.equal(assessVideo(JSON.parse(readFileSync(join(LIVE, 'How-to-archive-a-policy', 'job.json'), 'utf8'))).decision, 'skip');
});

test('assessVideo: empty-state and unconfirmed-redesign slides are skipped with a reason', () => {
  const job = (codes) => ({ status: 'ok', verdict: 'unchanged', complete: false, steps: [{ index: 0, verdict: 'unverified', reasons: codes.map((code) => ({ verdict: 'unverified', code })) }] });
  assert.equal(assessVideo(job(['empty_state'])).reason, 'empty_or_missing_data_unverified');
  assert.equal(assessVideo(job(['redesign_not_confirmed'])).reason, 'no_release_confirmed_ui_redesign');
  assert.equal(assessVideo(job(['no_release_touched_screen'])).decision, 'skip');
  assert.equal(assessVideo(job(['redesign_unreviewed'])).reason, 'no_release_confirmed_ui_redesign');
});

test('submission uses the whole completed run before a names filter; ignored claims never enter payloads', () => {
  const moved={element:'sidebar',kind:'moved',before:'Ask Hadrius',after:'Ask Hadrius',commit:'c'.repeat(40),verified:true};
  const added={...moved,kind:'added',before:null,after:'Risk level'};
  const rename=release.redesign.changes[0];
  const mk=(name,route,changes)=>job({name,steps:[step(0,'slide_update',[R('slide_update','ui_changed')],{
    uiContext:{route,slideText:''},uiReleaseEvidence:confirmedRelease({routePath:route,redesign:{confirmed:true,changes,rejected:[]}})})]});
  const jobs={Mixed:mk('Mixed','/rules',[rename,moved,added]),FrameA:mk('FrameA','/people',[moved]),FrameB:mk('FrameB','/policies',[moved]),Added:mk('Added','/exceptions',[added])};
  const summary={finishedAt:'2026-10-31T20:00:00Z',videos:Object.keys(jobs).map(name=>({name}))};
  const scripts=Object.fromEntries(Object.keys(jobs).map(name=>[name,{...script(1),name}]));
  const io=runIo(jobs,scripts),completed=finalized(summary,io);
  const rows=prepareSubmissions({summary:completed,runDir:'/r',io});
  // Without a certified preview video an update is never offered for approval (preview-bound approvals).
  assert.deepEqual(rows.map(r=>[r.name,r.decision]),[['Mixed','skip'],['FrameA','skip'],['FrameB','skip'],['Added','skip']]);
  assert.equal(rows[0].reason,'no_certified_preview');
  assert.equal(rows[3].reason,'ui_additions_only');
  const changes=rows[0].payload.details.changes;
  assert.deepEqual(changes.map(c=>c.index),[0]);assert.deepEqual(changes[0].reasonCodes,['ui_changed']);
  assert.deepEqual(changes[0].uiReleaseEvidence.redesign.changes,[rename]);
  assert.doesNotMatch(blocksToText(buildDriftMessage({id:'offline',...rows[0].payload})),/Risk level|Ask Hadrius/);
  assert.equal(prepareSubmissions({summary:completed,runDir:'/r',names:['FrameA'],io})[0].decision,'skip');
  jobs.Mixed.steps[0].uiContext.slideText='changed input';
  assert.equal(prepareSubmissions({summary:completed,runDir:'/r',io})[0].reason,'weekly_selection_required');
});

test('unfinished runs and standalone buildPayload fail closed instead of bypassing selection', () => {
  const j=redesignJob();
  assert.equal(assessVideo(j).decision,'skip');assert.equal(assessVideo(j).reason,'weekly_selection_required');
  assert.throws(()=>buildPayload({job:j,script:script()}),/weekly_selection_required/);
  const rows=prepareSubmissions({summary:{videos:[{name:'Vid'}]},runDir:'/r',io:runIo({Vid:j})});
  assert.equal(rows[0].decision,'skip');assert.equal(rows[0].reason,'weekly_run_incomplete');
  const legacy=prepareSubmissions({summary:{finishedAt:'2026-10-31T20:00:00Z',videos:[{name:'Vid'}]},runDir:'/r',io:runIo({Vid:j})});
  assert.equal(legacy[0].decision,'skip');assert.equal(legacy[0].reason,'weekly_selection_required');
});

test('prepareSubmissions with includeAutomaticRepairs posts certified automatic repairs as auto_update and keeps holds skipped', () => {
  const autoJob = job({
    name: 'Vid', verdict: 'slide_update',
    steps: [step(0, 'slide_update', [R('slide_update', 'ui_changed')], { uiReleaseEvidence: release }), step(1, 'unchanged'), step(2, 'unchanged')],
    candidate: { recordingPath: '/prep/Vid/candidate-rec' },
    candidateInputs: { schema: 1, scriptName: 'Vid', weeklyDir: '/prep/Vid', identifiedScript: '/prep/Vid/identified-base.script.json', candidateManifest: '/prep/Vid/candidate-manifest.json' },
  });
  const heldJob = redesignJob('Held');
  const scripts = { Vid: script(), Held: { ...script(), name: 'Held' } };
  const selection = selectWeeklyJobs([autoJob, heldJob], { readScript: (n) => scripts[n] });
  const report = {
    schema: 1, finishedAt: '2026-11-02T00:00:00Z', sourceSelectionInputHash: selection.inputHash,
    preparationDir: '/prep', names: ['Held', 'Vid'], selectedPairs: ['Held#0', 'Vid#0'],
    rows: [
      { name: 'Vid', status: 'automatically_repaired', qa: { ok: true, baselineDir: '/baselines/Vid/h1' }, result: { candidate: '/results/Vid/candidate.mp4', sha256: 'a'.repeat(64), verification: '/results/Vid/repair/verification.json', automaticQa: '/results/Vid/automatic-qa.json' } },
      { name: 'Held', status: 'evidence_pending', reason: 'needs_fixture' },
    ],
  };
  const summary = {
    finishedAt: '2026-11-02T00:00:00Z', videos: [{ name: 'Vid' }, { name: 'Held' }],
    uiSelection: selectionMarker(selection), automation: { status: 'finished', report: '/r/automation-report.json' },
  };
  const files = {
    '/r/Vid/job.json': autoJob, '/r/Held/job.json': heldJob,
    '/prep/Vid/job.json': autoJob, '/prep/Held/job.json': heldJob,
    '/r/automation-report.json': report,
  };
  const io = { readJson: (p) => files[p] ?? null, readScript: (n) => scripts[n] ?? null, readAssembly: () => null };
  // Default (includeAutomaticRepairs: false) skips automatic repairs
  const defaultRows = prepareSubmissions({ summary, runDir: '/r', io });
  assert.deepEqual(defaultRows.map((r) => [r.name, r.decision, r.reason]), [['Vid', 'skip', 'automatically_repaired'], ['Held', 'skip', 'evidence_pending']]);
  // Explicit includeAutomaticRepairs: true posts Vid as auto_update with automaticResult attached
  const autoRows = prepareSubmissions({ summary, runDir: '/r', io, includeAutomaticRepairs: true });
  assert.deepEqual(autoRows.map((r) => [r.name, r.decision, r.kind ?? null]), [['Vid', 'post', 'auto_update'], ['Held', 'skip', null]]);
  assert.equal(autoRows[0].payload.details.execution.rebaselineDir, '/baselines/Vid/h1');
  assert.equal(autoRows[0].payload.details.execution.candidateRecordingsDir, '/prep/Vid/candidate-rec');
  assert.deepEqual(autoRows[0].payload.details.execution.automaticResult, {
    candidate: '/results/Vid/candidate.mp4', sha256: 'a'.repeat(64),
    verification: '/results/Vid/repair/verification.json', automaticQa: '/results/Vid/automatic-qa.json',
    baselineDir: '/baselines/Vid/h1',
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJobDetails, createJobsClient, fingerprintOf, plainReason, serviceUrlFrom, DriftServiceError } from '../../tools/drift/jobs.mjs';

export const SCRIPT = {
  name: 'Approving-Marketing-Reviews', title: 'Approving Marketing Reviews', module: 'Marketing',
  steps: [
    { narration: 'Open Marketing from the sidebar.' },
    { narration: 'Click the review you want to approve.' },
    { narration: 'Press Approve to sign off on the review.' },
    { narration: 'The status changes to Approved.' },
  ],
};
export const WEEKLY_JOB = {
  schema: 1, name: 'Approving-Marketing-Reviews', status: 'ok', verdict: 'narration_review', complete: false,
  summary: 'Screenshot changed and narration may be inaccurate: human narration review. slide 3: narration_inaccurate (button now says Sign off).',
  startedAt: '2026-10-26T08:00:00.000Z', finishedAt: '2026-10-26T08:04:00.000Z', reasons: [],
  evidence: { contactSheet: '/scratch/weekly/Approving/capture/contact.png' },
  steps: [
    { index: 0, action: 'click', verdict: 'unchanged', reasons: [] },
    { index: 1, action: 'click', verdict: 'moved_highlight', reasons: [{ verdict: 'moved_highlight', code: 'target_moved', detail: 'target moved/resized by up to 38px' }],
      metrics: { diff: 0.004, ssimMasked: 0.97 }, evidence: { recorded: '/rec/step_b.png', today: '/run/today_1.png', diff: '/run/diff_1.png' } },
    { index: 2, action: 'click', verdict: 'narration_review', reasons: [
      { verdict: 'slide_update', code: 'screenshot_changed', detail: 'diff 2.10% non-dynamic, SSIM 0.93' },
      { verdict: 'narration_review', code: 'narration_inaccurate', detail: 'the button now says "Sign off", not "Approve"' }],
      metrics: { diff: 0.021, ssimMasked: 0.93 }, evidence: { recorded: '/rec/step_c.png', today: '/run/today_2.png' } },
    { index: 3, action: 'click', verdict: 'unverified', reasons: [{ verdict: 'unverified', code: 'needs_fixture', detail: 'replay stopped before a data-changing step' }] },
  ],
};

test('buildJobDetails: auto_update with proposed narration lists exactly what changes and what stays', () => {
  const j = buildJobDetails({ weeklyJob: WEEKLY_JOB, script: SCRIPT, proposedNarration: { 2: 'Press Sign off to approve the review.' },
    links: { drive: 'https://drive.google.com/file/d/abc/view', pylon: 'https://help.example/a/1' }, prs: [{ number: 812, title: 'Rename Approve to Sign off', url: 'https://github.com/x/y/pull/812' }],
    slideDurations: [4, 5, 6, 5], oldDurationSec: 30 });
  assert.equal(j.kind, 'auto_update');
  assert.equal(j.video_title, 'Approving Marketing Reviews');
  const d = j.details;
  assert.deepEqual(d.changes.map((c) => [c.step, c.changeTypes]), [[2, ['highlight']], [3, ['screenshot', 'narration']]]);
  assert.equal(d.changes[1].oldNarration, 'Press Approve to sign off on the review.');
  assert.equal(d.changes[1].newNarration, 'Press Sign off to approve the review.');
  assert.deepEqual(d.untouched.steps, [1, 4]);
  assert.deepEqual(d.untouched.narrationUnchangedSteps, [1, 2, 4]);
  assert.equal(d.untouched.framesPreservedPct, 45); // (4+5)/20
  assert.equal(d.untouched.unverified[0].step, 4);
  assert.equal(d.elevenLabsChars, 'Press Sign off to approve the review.'.length);
  assert.equal(d.untouched.oldDurationSec, 30); assert.equal(d.untouched.newDurationSec, 29.6); // 8 → 7 words ≈ -0.4 s
  assert.equal(d.detection.source, 'merged_prs+recapture');
  assert.equal(d.changes[0].before.path, '/rec/step_b.png'); assert.equal(d.changes[0].after.path, '/run/today_1.png');
  assert.match(d.changes[0].why[0], /moved\/resized by up to 38px, so the highlight box must move/);
  assert.match(j.fingerprint, /^fp1-[0-9a-f]{40}$/);
});

test('buildJobDetails: narration flagged without replacement text → manual_rerecord with a reason', () => {
  const j = buildJobDetails({ weeklyJob: WEEKLY_JOB, script: SCRIPT });
  assert.equal(j.kind, 'manual_rerecord');
  assert.match(j.details.rerecordReason.join(' '), /step\(s\) 3 may be wrong and no replacement text/);
});

test('buildJobDetails: full_rerecord verdict → manual_rerecord with plain-English reasons', () => {
  const wj = { ...WEEKLY_JOB, verdict: 'full_rerecord', steps: [{ index: 0, action: 'click', verdict: 'full_rerecord', reasons: [{ verdict: 'full_rerecord', code: 'route_changed', detail: 'page route changed: recorded /a -> today /b' }] }] };
  const j = buildJobDetails({ weeklyJob: wj, script: SCRIPT });
  assert.equal(j.kind, 'manual_rerecord');
  assert.deepEqual(j.details.rerecordReason, ['Step 1: The page moved to a different address (page route changed: recorded /a -> today /b).']);
});

test('fingerprint is stable across weekly runs (paths/metrics ignored) and changes with the drift', () => {
  const a = buildJobDetails({ weeklyJob: WEEKLY_JOB, script: SCRIPT, proposedNarration: { 2: 'X y z.' } });
  const moved = JSON.parse(JSON.stringify(WEEKLY_JOB));
  moved.steps[1].evidence.today = '/other-run/today_1.png'; moved.steps[2].metrics.diff = 0.03; moved.finishedAt = '2026-11-02T08:00:00Z';
  const b = buildJobDetails({ weeklyJob: moved, script: SCRIPT, proposedNarration: { 2: 'X y z.' } });
  assert.equal(a.fingerprint, b.fingerprint);
  const c = buildJobDetails({ weeklyJob: WEEKLY_JOB, script: SCRIPT, proposedNarration: { 2: 'Different text.' } });
  assert.notEqual(a.fingerprint, c.fingerprint);
  assert.equal(fingerprintOf({ name: 'n', kind: 'auto_update', changes: [] }), fingerprintOf({ name: 'n', kind: 'auto_update', changes: [] }));
});

test('plainReason covers classifier codes', () => {
  assert.match(plainReason({ code: 'screenshot_changed', detail: 'diff 2.10% non-dynamic, SSIM 0.93' }), /2\.10% of the screen changed/);
  assert.match(plainReason({ code: 'persistent_chrome_changed' }), /sidebar\/header/);
  assert.equal(plainReason({ code: 'weird', detail: 'raw' }), 'raw');
});

test('serviceUrlFrom derives the service from the library host', () => {
  assert.equal(serviceUrlFrom('https://pylon-webhook-service.vercel.app/api/studio-beta-scripts'), 'https://pylon-webhook-service.vercel.app/api/studio-drift');
  assert.equal(serviceUrlFrom('http://localhost:3000/api/studio-scripts?x=1'), 'http://localhost:3000/api/studio-drift');
  assert.equal(serviceUrlFrom(''), 'https://pylon-webhook-service.vercel.app/api/studio-drift');
});

function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null }); const [status, body] = handler(url, init); return { status, ok: status >= 200 && status < 300, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }; };
  return { f, calls };
}

test('client: bearer auth, routes and bodies', async () => {
  const { f, calls } = fakeFetch(() => [200, { status: 'ok', jobs: [] }]);
  const c = createJobsClient({ baseUrl: 'https://svc/api/studio-drift', getSecret: () => 'sek', fetchImpl: f });
  await c.list({ status: ['pending_approval', 'needs_rerecord'] });
  await c.decide({ id: 'i', decision: 'approve', by: 'stephen', via: 'extension', expectedVersion: 3 });
  await c.attachSlack({ id: 'i', channel: 'C0CD42Y6RU6', ts: '1.2', blocks: [] });
  await c.progress({ id: 'i', status: 'in_progress' });
  assert.equal(calls[0].url, 'https://svc/api/studio-drift?status=pending_approval%2Cneeds_rerecord');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sek');
  assert.equal(calls[1].url, 'https://svc/api/studio-drift?action=decide');
  assert.deepEqual(calls[1].body, { id: 'i', decision: 'approve', by: 'stephen', via: 'extension', note: null, expectedVersion: 3 });
  assert.equal(calls[2].url, 'https://svc/api/studio-drift?action=slack');
  assert.equal(calls[3].init.method, 'PATCH');
});

test('client: clear errors for not configured, not deployed, and 409 conflicts', async () => {
  const none = createJobsClient({ baseUrl: 'https://svc/x', getSecret: () => '', fetchImpl: async () => { throw new Error('must not fetch'); } });
  await assert.rejects(none.list(), (e) => e instanceof DriftServiceError && e.code === 'not_configured' && /STUDIO_SHARED_SECRET/.test(e.message));
  const missing = createJobsClient({ baseUrl: 'https://svc/x', getSecret: () => 's', fetchImpl: fakeFetch(() => [404, '<html>The page could not be found</html>']).f });
  await assert.rejects(missing.list(), (e) => e.code === 'service_missing' && /isn't deployed yet/.test(e.message));
  const conflict = createJobsClient({ baseUrl: 'https://svc/x', getSecret: () => 's', fetchImpl: fakeFetch(() => [409, { error: 'Already approved by <@U1>', decided_by: 'alex', status: 'approved' }]).f });
  await assert.rejects(conflict.decide({ id: 'i', decision: 'deny', by: 'b', via: 'extension' }), (e) => e.code === 'conflict' && e.status === 409 && e.body.decided_by === 'alex');
});

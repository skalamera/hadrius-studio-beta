// Shared selection policy: no browser, model, service or filesystem.
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectWeeklyJobs, selectedJob, normalizedRoute } from '../../tools/drift/ui-selection.mjs';
import { confirmedRelease } from './release-fixture.mjs';

const change = (kind, before, after) => ({ element: 'control', kind, before, after, verified: true, commit: 'c'.repeat(40) });
const rename = change('renamed', 'Create rule', 'New rule');
const added = change('added', null, 'Risk level');
const moved = change('moved', 'Ask Hadrius', 'Ask Hadrius');
const st = (index, route, changes) => ({ index, verdict: 'slide_update', reasons: [{ code: 'ui_changed', verdict: 'slide_update' }],
  uiContext: { route, slideText: '' }, uiReleaseEvidence: confirmedRelease({ routePath: route, redesign: { confirmed: true, changes, rejected: [], raw: { private: 'diagnostic only' } } }) });
const job = (name, steps) => ({ name, status: 'ok', verdict: 'slide_update', reasons: [], steps });

export const selectionFixture = () => [
  job('Mixed', [st(0, '/rules', [rename, added, moved]), st(1, '/rules', [added]), st(2, '/rules', [moved])]),
  job('FrameA', [st(0, '/policies', [moved])]),
  job('FrameB', [st(0, '/exams', [moved])]),
  job('UsedFrame', [{ ...st(0, '/people', [moved]), uiContext: { route: '/people', slideText: 'Click Ask Hadrius.' } }]),
  job('Added', [st(0, '/exceptions', [added])]),
];

test('shared policy selects only meaningful changes; projection cannot leak ignored changes or mutate diagnostics', () => {
  const jobs = selectionFixture(), before = structuredClone(jobs);
  const result = selectWeeklyJobs(jobs);
  assert.deepEqual(result.review.flagged.map(v => [v.name, v.slides.map(s => s.index)]), [['Mixed', [0]], ['UsedFrame', [0]]]);
  assert.equal(result.byName.get('Added').reason, 'ui_additions_only');
  assert.equal(result.byName.get('FrameA').reason, 'unused_app_frame_changes');
  const projected = selectedJob(jobs[0], result.byName.get('Mixed'));
  assert.deepEqual(projected.steps.map(s => s.index), [0]);
  assert.deepEqual(projected.steps[0].uiReleaseEvidence.redesign.changes, [rename]);
  assert.equal(projected.steps[0].uiReleaseEvidence.redesign.raw, undefined);
  assert.deepEqual(jobs, before, 'the full evidence is unchanged');
  const changed=structuredClone(jobs[0]);changed.steps[0].uiContext.slideText='Now click Ask Hadrius';
  assert.equal(selectedJob(changed,result.byName.get('Mixed')),null,'stale selection cannot scope changed input');
});

test('policy validates raw release evidence, ignores stale cached selections and handles missing context closed', () => {
  const bad = job('Bad', [{ ...st(0, '/x', [rename]), uiReleaseEvidence: null }]);
  bad.uiSelection = { status: 'selected', slides: [{ index: 0 }] };
  assert.deepEqual(selectWeeklyJobs([bad]).review.flagged, []);
  const missing = job('Missing', [{ ...st(0, '/x', [rename]), uiContext: undefined }]);
  assert.equal(selectWeeklyJobs([missing]).byName.get('Missing').reason, 'selection_context_missing');
  assert.equal(selectedJob(missing, null), null);
  const unverified = job('Unverified', [{ ...st(0, '/x', [rename]), verdict: 'unverified' }]);
  assert.deepEqual(selectWeeklyJobs([unverified]).review.flagged, []);
});

test('context can be supplied by the saved script and release route; unknown routes never add cross-page votes', () => {
  const a = job('A', [{ ...st(0, '/people/123', [moved]), uiContext: undefined }]);
  const b = job('B', [{ ...st(0, '/people/456', [moved]), uiContext: undefined }]);
  const c = job('C', [{ ...st(0, null, [moved]), uiContext: { route: null, slideText: '' } }]);
  const r = selectWeeklyJobs([a, b, c], { readScript: () => ({ steps: [{ index: 0, narration: 'Open the page' }] }) });
  assert.deepEqual(r.review.frameChanges, []);
  assert.equal(normalizedRoute('https://app.hadrius.com/people/123?company_id=1150'), '/people/:id');
  assert.equal(normalizedRoute(null), null);
});

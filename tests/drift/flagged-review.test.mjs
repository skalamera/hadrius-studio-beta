import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeReports, appFrameSignatures, sortVideos, tally, renderMarkdown, renderHtml } from '../../tools/drift/flagged-review.mjs';

const C = 'c'.repeat(40), S = 's'.repeat(40), N = 'n'.repeat(40);
const step = (index, extra = {}) => ({ index, verdict: 'unverified', codes: ['unverified:empty_state'], redesignConfirmed: false, release: 'candidates', commits: [], redesign: null, ...extra });
const commits = [
  { sha: C, pr: 5536, subject: 'COR-669 Configuration owns the trade monitoring section URL (#5536)', files: ['a.tsx'] },
  { sha: S, pr: 4997, subject: 'BAS-372 Add accessible sidebar account menu (#4997)', files: ['sidebar.tsx'] },
  { sha: N, pr: 4977, subject: 'TRA-1086 exceptions table (#4977)', files: ['table.tsx'] }];
const confirmedWith = (index, changes) => step(index, {
  verdict: 'slide_update', codes: ['slide_update:screenshot_changed', 'slide_update:ui_changed'], redesignConfirmed: true, commits,
  redesign: { confirmed: true, reason: 'x', changes: changes.map((c) => ({ verified: true, ...c })), rejected: [] } });
const renamed = { element: 'tab', kind: 'renamed', before: 'Flagging rules', after: 'Rules', commit: C };
const askMoved = (before = 'Ask Hadrius') => ({ element: 'sidebar entry', kind: 'moved', before, after: 'Ask Hadrius', commit: S });
const riskAdded = { element: 'filter', kind: 'added', before: null, after: 'Risk level', commit: N };
const confirmed = (index) => confirmedWith(index, [renamed]);

test('mergeReports: a later report replaces the same video unless it was skipped there; run dirs are kept', () => {
  const main = { runDir: '/runs/main', videos: [{ name: 'A', before: 'full_rerecord', after: 'unchanged', steps: [step(0)] }, { name: 'B', skipped: 'no_capture_or_script' }] };
  const retry = { runDir: '/runs/retry', videos: [{ name: 'B', before: 'full_rerecord', after: 'slide_update', steps: [confirmed(1)] }, { name: 'A', skipped: 'no_capture_or_script' }] };
  const m = mergeReports([main, retry]);
  assert.deepEqual([...m.keys()], ['A', 'B']);
  assert.equal(m.get('A').runDir, '/runs/main'); assert.equal(m.get('B').runDir, '/runs/retry');
  assert.equal(m.get('B').after, 'slide_update');
});

test('sortVideos: renamed/removed/moved page controls mislead; a change seen on 3+ pages is the app frame; new controls alone do not mislead', () => {
  const m = mergeReports([{ runDir: '/r', videos: [
    { name: 'A', before: 'full_rerecord', after: 'unchanged', steps: [step(0), step(1)] },
    { name: 'B', before: 'full_rerecord', after: 'slide_update', steps: [step(0), confirmed(1), confirmedWith(3, [renamed, askMoved()])] },
    { name: 'F1', before: 'full_rerecord', after: 'slide_update', steps: [confirmedWith(0, [askMoved()])] },
    { name: 'F2', before: 'full_rerecord', after: 'slide_update', steps: [confirmedWith(0, [askMoved('Ask Hadrius (near the bottom)')])] },
    { name: 'F3', before: 'full_rerecord', after: 'slide_update', steps: [confirmedWith(0, [askMoved()])] },
    { name: 'U', before: 'full_rerecord', after: 'slide_update', steps: [confirmedWith(2, [askMoved()])] },
    { name: 'R', before: 'full_rerecord', after: 'slide_update', steps: [confirmedWith(0, [riskAdded])] }] }]);
  const routes = { B: '/trade-monitoring', F1: '/policies', F2: '/exams', F3: '/people', U: '/calendar', R: '/exceptions' };
  const routeOf = (v) => routes[v.name];
  const slideTextOf = (v, i) => (v.name === 'U' && i === 2 ? 'Click Ask Hadrius in the sidebar.' : '');
  assert.deepEqual([...appFrameSignatures(m, routeOf)], ['moved|ask hadrius']);
  const r = sortVideos(m, { routeOf, slideTextOf });
  assert.deepEqual(r.flagged.map((v) => [v.name, v.slides.map((s) => s.index)]), [['B', [1, 3]], ['U', [2]]]);
  assert.deepEqual(r.flagged[0].slides[1].changes.map((c) => c.after), ['Rules']);
  assert.deepEqual(r.flagged[0].slides[0].changes[0], { element: 'tab', kind: 'renamed', before: 'Flagging rules', after: 'Rules', pr: 5536, sha: C, subject: 'COR-669 Configuration owns the trade monitoring section URL (#5536)' });
  assert.deepEqual(r.newControlsOnly.map((v) => v.name), ['R']);
  assert.deepEqual(r.frameOnly.map((v) => v.name), ['F1', 'F2', 'F3']);
  assert.equal(r.flagged[0].stepCount, 3);
});

test('tally: checked/not captured, old checker verdicts and slide reasons', () => {
  const m = mergeReports([{ runDir: '/r', videos: [
    { name: 'A', before: 'full_rerecord', after: 'unchanged', steps: [step(0), step(1, { codes: ['unverified:redesign_not_confirmed'] })] },
    { name: 'B', before: 'full_rerecord', after: 'slide_update', steps: [confirmed(0)] },
    { name: 'C', skipped: 'no_capture_or_script' }] }]);
  const t = tally(m);
  assert.deepEqual(t.videos, { total: 3, checked: 2, notCaptured: 1 });
  assert.deepEqual(t.oldVerdicts, { full_rerecord: 2 });
  assert.equal(t.slideCodes['unverified:empty_state'], 1);
  assert.equal(t.slideCodes['unverified:redesign_not_confirmed'], 1);
});

test('renderMarkdown / renderHtml: flagged list with PR links and side-by-side images; other groups listed; text escaped', () => {
  const m = mergeReports([{ runDir: '/r', videos: [
    { name: 'B<x>', before: 'full_rerecord', after: 'slide_update', steps: [confirmed(1)] },
    { name: 'R', before: 'full_rerecord', after: 'slide_update', steps: [confirmedWith(0, [riskAdded])] }] }]);
  const r = sortVideos(m, { routeOf: () => '/x' });
  const md = renderMarkdown(r, tally(m));
  assert.match(md, /B<x>/); assert.match(md, /slide 2: renamed "Flagging rules" → "Rules" \(PR #5536/);
  assert.match(md, /https:\/\/github\.com\/1Quantbase\/hadrius_frontend\/pull\/5536/);
  assert.match(md, /Not flagged: only new controls[\s\S]*R: added "Risk level" \(PR #4977\)/);
  const html = renderHtml(r, tally(m), { imagesFor: () => ({ recorded: '/rec/one.png', today: '/r/B/capture/step-01-today.png' }) });
  assert.match(html, /B&lt;x&gt;/); assert.doesNotMatch(html, /B<x>/);
  assert.match(html, /src="file:\/\/\/rec\/one\.png"/); assert.match(html, /src="file:\/\/\/r\/B\/capture\/step-01-today\.png"/);
  assert.match(html, /“Flagging rules” → “Rules”/);
});

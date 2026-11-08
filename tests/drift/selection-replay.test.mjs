import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileInventory, replayChecks } from '../../tools/drift/selection-replay.mjs';

test('inventory: stray folders are not failed allowlisted videos; captured retries count once', () => {
  const merged = new Map([['A',{name:'A',steps:[]}],['B',{name:'B',skipped:'no_capture_or_script'}],['stray',{name:'stray',skipped:'no_capture_or_script'}]]);
  assert.deepEqual(reconcileInventory(merged,['A','B','C','A']),{allowlisted:3,reportEntries:3,capturedAllowlisted:1,missingAllowlisted:['B','C'],outsideAllowlist:['stray']});
});

test('replay carries fresh narration/target checks rather than resurrecting stale raw-job failures', () => {
  const original = { judge: { skipped: 'old scope' }, target: { status: 'missing' }, guard: 'needs_fixture', reasons: [{ code: 'old' }] };
  const judge = { accurate: true, reason: 'visible on current screenshot', model: 'review-model' };
  const reasons = [{ verdict: 'slide_update', code: 'ui_changed', detail: 'actual reviewed reason' }];
  const reviewed = { judge, target: { status: 'resolved' }, guard: null, reasons, codes: ['slide_update:ui_changed'] };
  const result = replayChecks(original, reviewed);
  assert.deepEqual(result.judge, judge); assert.deepEqual(result.target, { status: 'resolved' });
  assert.equal(result.guard, null); assert.deepEqual(result.reasons, reasons);
  assert.equal(original.judge.skipped, 'old scope', 'raw evidence is never mutated');
  const legacy = replayChecks(original, { codes: ['unverified:empty_state'] });
  assert.deepEqual(legacy.judge, original.judge); assert.deepEqual(legacy.target, original.target);
  assert.equal(legacy.reasons[0].code, 'empty_state');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../tools/drift/contracts.mjs';
import { repairReviewBinding } from '../../tools/drift/semantic-repair.mjs';
import { semanticStepDigest, semanticRepairCheck } from '../../tools/drift/semantic-repair-proof.mjs';
import { assessRepair } from '../../tools/drift/repairability.mjs';

function fixture() {
  const step = { index: 0, verdict: 'full_rerecord', reasons: ['ui_changed', 'page_redesigned', 'narration_unchecked'].map(code => ({ code, verdict: 'full_rerecord' })),
    evidence: { recorded: '/recorded.png', today: '/current.png' }, uiContext: { route: '/rules', visibleText: 'Rules\nFilter by rule' } };
  const script = { index: 0, action: 'navigate', url: 'https://app.hadrius.com/rules', narration: 'Review your rules.' };
  const changes = [{ kind: 'moved', before: 'Filter by rule', after: 'Filter by rule', element: 'filter' }];
  const binding = repairReviewBinding({ videoName: 'Vid', stepIndex: 0, scriptStep: script, selectedVerifiedChanges: changes,
    source: { job: { stepDigest: semanticStepDigest(step), recordedPath: step.evidence.recorded, currentPath: step.evidence.today }, capture: { sha256: 'a'.repeat(64) } },
    imageSha256s: { recorded: 'b'.repeat(64), current: 'c'.repeat(64) }, captureContext: { pageState: 'loaded', recordSpecificAction: false, taskContext: 'verified' } });
  const claim = (status) => ({ status, reason: 'Same visible rules page and filter function.', evidence: 'Rules heading and Filter by rule are visible.', recordsIndependent: true });
  const review = { schema: 'semantic-repair-review-v1', bindingDigest: binding.digest, workflow: claim('equivalent'),
    narration: { ...claim('accurate'), suggestedNarration: null, preservesIntent: true, intentEvidence: 'The original task remains reviewing rules on the visible rules page.' },
    target: { ...claim('not_applicable'), currentLabel: null, bbox: null }, linkedInterface: claim('affected') };
  const checked = { verified: true, reason: 'Independently inspected the current rules page.', evidence: 'Same Rules heading and named filter on current image.' };
  const metadata = { provider: 'test-provider', model: 'model-a', reviewId: 'author-check' };
  const verification = { bindingDigest: binding.digest, reviewDigest: digest(review), currentImageSha256: binding.imageSha256s.current,
    verifier: { kind: 'model', id: 'independent-check', provider: 'test-provider', model: 'model-a', reviewId: 'independent-check' },
    workflow: checked, narration: { ...checked, text: script.narration, preservesIntent: true, intentEvidence: 'Still instructs the viewer to review rules, not another task.' },
    target: { ...checked, currentLabel: null }, linkedInterface: checked };
  step.semanticRepair = { binding, review, metadata, verification };
  return { step, script, changes };
}

test('positive independently checked semantics may waive pixel-only and unchecked-narration blockers', () => {
  const { step, script, changes } = fixture();
  const checked = semanticRepairCheck(step, script, changes, 'Vid');
  assert.equal(checked.executionReady, true);
  const r = assessRepair({ name: 'Vid', steps: [step], scriptSteps: [script], slides: [{ index: 0, changes }] });
  assert.equal(r.decision, 'auto'); assert.equal(r.blockers.length, 0);
  assert.ok(r.notes.some(x => x.code === 'semantic_repair_verified'));
  assert.ok(step.reasons.some(x => x.code === 'page_redesigned'), 'raw diagnostics must remain unchanged');
});

test('missing, self-certified or stale proof cannot bypass conservative default', () => {
  for (const mutate of [x => { delete x.step.semanticRepair; }, x => { x.step.semanticRepair.verification = null; },
    x => { x.script.narration = 'Different instruction.'; }, x => { x.step.target = { status: 'missing' }; },
    x => { x.changes.push({ kind: 'renamed', before: 'Old', after: 'New' }); },
    x => { x.step.evidence.today = '/other.png'; }, x => { x.step.semanticRepair.metadata.reviewId = 'independent-check'; }]) {
    const data = fixture(); mutate(data);
    const r = assessRepair({ name: 'Vid', steps: [data.step], scriptSteps: [data.script], slides: [{ index: 0, changes: data.changes }] });
    assert.equal(r.decision, 'manual'); assert.ok(r.blockers.some(x => x.code === 'large_redesign'));
  }
});

test('name/step/source changes invalidate proof; target/narration failures are not silently cleared', () => {
  const data = fixture();
  assert.equal(semanticRepairCheck(data.step, data.script, data.changes, 'Other video'), null);
  data.step.reasons.push({ code: 'target_missing', verdict: 'full_rerecord' });
  assert.equal(semanticRepairCheck(data.step, data.script, data.changes, 'Vid'), null);
  const r = assessRepair({ name: 'Vid', steps: [data.step], scriptSteps: [data.script], slides: [{ index: 0, changes: data.changes }] });
  assert.ok(r.blockers.some(x => x.code === 'click_target_changed'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../tools/drift/contracts.mjs';
import { repairReviewBinding, validateSemanticRepairReview } from '../../tools/drift/semantic-repair.mjs';
import { semanticStepDigest } from '../../tools/drift/semantic-repair-proof.mjs';
import { routeAutomation, routeAutomationVideo, AUTOMATION_ROUTES, RENDERER_CLASSES } from '../../tools/drift/automation-policy.mjs';

function example() {
  const name = 'Any-Video-No-Allowlist', scriptSteps = [{ id: 's0', index: 0, action: 'navigate', capture: true,
    media: { pre: 'old.png' }, narration: 'Open the directory.', caption: 'Open the directory.' }];
  const steps = [{ index: 0, verdict: 'full_rerecord', reasons: [{ code: 'page_redesigned' }], evidence: { recorded: '/old.png', today: '/new.png' } }];
  const slides = [{ index: 0, changes: [{ kind: 'moved', before: 'Directory', after: 'Directory' }] }];
  const binding = repairReviewBinding({ videoName: name, stepIndex: 0, scriptStep: scriptSteps[0], selectedVerifiedChanges: slides.flatMap(s => s.changes),
    source: { job: { stepDigest: semanticStepDigest(steps[0]), recordedPath: '/old.png', currentPath: '/new.png' }, capture: { path: '/run.json', sha256: 'c'.repeat(64) } },
    imageSha256s: { recorded: 'a'.repeat(64), current: 'b'.repeat(64) }, captureContext: { pageState: 'loaded', taskContext: 'verified', recordSpecificAction: false } });
  const claim = { reason: 'The directory toolbar still opens the same directory.', evidence: 'Directory remains visible above the list.', recordsIndependent: true };
  const review = { schema: 'semantic-repair-review-v1', bindingDigest: binding.digest,
    workflow: { ...claim, status: 'equivalent' }, narration: { ...claim, status: 'accurate', suggestedNarration: null, preservesIntent: true, intentEvidence: 'The same directory task remains supported.' },
    target: { ...claim, status: 'not_applicable', currentLabel: null }, linkedInterface: { ...claim, status: 'affected' } };
  const verified = { verified: true, reason: 'Independently compared the directory.', evidence: 'The current directory toolbar supports this claim.' };
  const verification = { bindingDigest: binding.digest, reviewDigest: digest(review), currentImageSha256: binding.imageSha256s.current,
    verifier: { kind: 'model', id: 'checker', provider: 'test', model: 'test', reviewId: 'checker-2' }, workflow: { ...verified },
    narration: { ...verified, text: scriptSteps[0].narration, preservesIntent: true, intentEvidence: 'Same directory action and outcome.' },
    target: { ...verified, currentLabel: null }, linkedInterface: { ...verified } };
  steps[0].semanticRepair = { binding, review, metadata: { provider: 'test', model: 'test', reviewId: 'author-1' }, verification };
  return { name, scriptSteps, steps, slides, repair: { decision: 'auto', blockers: [], extended: [], actions: [{ index: 0, action: 'replace_screenshot' }] },
    prerequisites: { baseline: true, input: true, identity: true, provider: true } };
}
function proof(f) { return f.steps[0].semanticRepair; }
function rebind(f) {
  const p = proof(f), { schema, digest: _, ...input } = p.binding;
  input.scriptStep = f.scriptSteps[0]; input.source.job.stepDigest = semanticStepDigest(f.steps[0]);
  input.source.job.currentPath = f.steps[0].evidence.today; input.selectedVerifiedChanges = f.slides.flatMap(s => s.changes);
  p.binding = repairReviewBinding(input); p.review.bindingDigest = p.binding.digest;
  p.verification.bindingDigest = p.binding.digest; p.verification.reviewDigest = digest(p.review);
}

test('supported independent proof routes old full_rerecord and large pixels automatically, without mutation', () => {
  const f = example(), before = digest(f), r = routeAutomation(f);
  assert.equal(r.status, 'automatic_repair', JSON.stringify(r)); assert.equal(r.humanRequired, false);
  assert.deepEqual(r.scope, { indices: [0], stepIds: ['s0'] }); assert.equal(digest(f), before);
  assert.deepEqual(RENDERER_CLASSES, ['screenshot', 'target_geometry', 'narration', 'timing']);
});
test('no change requires positive unchanged coverage, not merely an empty selection', () => {
  assert.equal(routeAutomation({ steps: [{ verdict: 'unchanged' }, { verdict: 'unchanged_with_data_drift' }] }).status, 'no_change');
  for (const steps of [[], [{ verdict: 'unverified' }], [{ verdict: 'full_rerecord' }]]) assert.equal(routeAutomation({ steps }).status, 'evidence_pending');
});
test('legacy manual is a hold, never proof of human work', () => {
  const f = example(); f.repair.decision = 'manual';
  assert.equal(routeAutomation(f).status, 'evidence_pending'); assert.equal(routeAutomation(f).humanRequired, false);
});
for (const key of ['baseline', 'input', 'identity', 'provider']) test(`${key} missing is setup, not human`, () => {
  const f = example(); delete f.prerequisites[key]; assert.equal(routeAutomation(f).status, 'setup_required');
});
for (const key of ['capture', 'fixture', 'target', 'model', 'budget']) test(`${key} missing stays evidence pending`, () => {
  const f = example(); f.prerequisites[key] = false; assert.equal(routeAutomation(f).status, 'evidence_pending');
});
for (const code of ['no_replacement_screenshot', 'click_target_changed', 'viewport_changed', 'large_redesign', 'narration_flagged',
  'narration_unchecked', 'narration_mentions_changed_label', 'click_target_uses_changed_label', 'kept_slide_shows_changed_element', 'linked_slide_unproven', 'some_future_blocker']) {
  test(`repair blocker ${code} does not invent complexity`, () => {
    const f = example(); f.repair = { ...f.repair, decision: 'manual', blockers: [{ code, slides: [0] }] };
    assert.equal(routeAutomation(f).status, 'evidence_pending');
  });
}
test('model ready/status booleans cannot replace a bound independent review', () => {
  for (const mutate of [f => { delete f.steps[0].semanticRepair; }, f => { proof(f).verification = null; },
    f => { proof(f).verification.verifier.reviewId = proof(f).metadata.reviewId; }, f => { f.scriptSteps[0].caption = 'Other task'; },
    f => { f.slides[0].changes[0].after = 'Another control'; }, f => { proof(f).review.workflow.status = 'unknown'; },
    f => { proof(f).executionReady = true; proof(f).review.target.status = 'same'; }]) {
    const f = example(); mutate(f); assert.equal(routeAutomation(f).status, 'evidence_pending');
  }
});
test('actual blocked/workflow_changed status alone does NOT mean independent verification', () => {
  const f = example(), p = proof(f); p.review.workflow.status = 'changed';
  p.verification = null; assert.equal(validateSemanticRepairReview(p.review, p).status, 'blocked');
  assert.equal(routeAutomation(f).status, 'evidence_pending');
});
test('positive independently verified changed workflow is the human route', () => {
  const f = example(), p = proof(f); p.review.workflow.status = 'changed'; p.verification.reviewDigest = digest(p.review);
  const r = routeAutomation(f); assert.equal(r.status, 'human_required'); assert.equal(r.humanRequired, true);
  f.structuralChanges = [{ type: 'insert_step' }]; assert.equal(routeAutomation(f).status, 'human_required');
});
test('even two changed-workflow judgments cannot turn missing targets, fixtures or records into proven complexity',()=>{
  for(const code of ['target_missing','target_ambiguous','needs_fixture','record_not_visible','data_missing']){
    const f=example(),p=proof(f);f.steps[0].reasons.push({code});rebind(f);p.review.workflow.status='changed';p.verification.reviewDigest=digest(p.review);
    assert.notEqual(routeAutomation(f).status,'human_required',code);
  }
});
test('stale, missing, rejected, self-authored and unknown workflow verification never prove complexity', () => {
  for (const mutate of [p => { p.verification.workflow.verified = false; }, p => { p.verification.workflow.evidence = 'unknown'; },
    p => { p.verification.reviewDigest = 'a'.repeat(64); }, p => { p.verification.verifier.reviewId = p.metadata.reviewId; },
    p => { p.binding.source.capture.sha256 = 'd'.repeat(64); }, p => { p.verification.currentImageSha256 = 'd'.repeat(64); }]) {
    const f = example(), p = proof(f); p.review.workflow.status = 'changed'; p.verification.reviewDigest = digest(p.review); mutate(p);
    assert.equal(routeAutomation(f).status, 'evidence_pending');
  }
});
test('unsupported proposed structure is not proof the task changed', () => {
  const f = example(); f.structuralChanges = [{ type: 'insert_step' }]; assert.equal(routeAutomation(f).status, 'evidence_pending');
});
test('supported intent-preserving narration rewrite is not a human rerecord requirement', () => {
  const f = example(), p = proof(f); p.review.narration.status = 'rewrite'; p.review.narration.suggestedNarration = 'Open the Directory tab.';
  p.verification.narration.text = p.review.narration.suggestedNarration; p.verification.reviewDigest = digest(p.review);
  assert.equal(routeAutomation(f).status, 'automatic_repair');
  f.renderer = { supportedClasses: ['screenshot'] }; assert.equal(routeAutomation(f).status, 'evidence_pending');
});
test('malformed or unsupported semantic intent is never repaired automatically', () => {
  const f = example(), p = proof(f); p.review.narration.preservesIntent = false; p.verification.reviewDigest = digest(p.review);
  assert.equal(routeAutomation(f).status, 'evidence_pending');
});
test('missing data is not a changed workflow and cannot be rewritten away', () => {
  const f = example(); proof(f).binding.captureContext = { pageState: 'empty', taskContext: 'missing_prerequisite', recordSpecificAction: true };
  rebind(f); assert.equal(routeAutomation(f).status, 'evidence_pending');
});
test('a positive record-independent static-label review may resolve an empty-page diagnostic',()=>{
  const f=example();f.steps[0].reasons.push({code:'empty_state'});proof(f).binding.captureContext.pageState='empty';rebind(f);
  assert.equal(routeAutomation(f).status,'automatic_repair');
  proof(f).review.workflow.recordsIndependent=false;proof(f).verification.reviewDigest=digest(proof(f).review);
  assert.equal(routeAutomation(f).status,'evidence_pending');
});
test('scope extensions require their own inputs, screenshots, identity, independent review and actions', () => {
  const f = example(); f.repair.extended = [1]; assert.equal(routeAutomation(f).status, 'setup_required');
  f.scriptSteps.push({ id: 's1', index: 1, media: { pre: 'two.png' } }); assert.equal(routeAutomation(f).status, 'evidence_pending');
});
test('malformed, duplicate, missing selected scope never auto repairs', () => {
  for (const mutate of [f => { f.slides.push(f.slides[0]); }, f => { f.repair.actions = []; }, f => { f.repair.actions.push(f.repair.actions[0]); },
    f => { f.scriptSteps[0].id = ''; }, f => { delete f.steps[0].evidence.today; }, f => { f.slides[0].changes = []; }]) {
    const f = example(); mutate(f); assert.notEqual(routeAutomation(f).status, 'automatic_repair'); assert.notEqual(routeAutomation(f).status, 'human_required');
  }
});
test('no per-video exceptions: renaming and rebinding any arbitrary video retains routing', () => {
  const f = example(); f.name = 'Never-Seen-Before'; proof(f).binding.videoName = f.name; rebind(f);
  assert.equal(routeAutomation(f).status, 'automatic_repair');
  assert.deepEqual(AUTOMATION_ROUTES, ['no_change', 'automatic_repair', 'evidence_pending', 'setup_required', 'human_required']);
});

function weeklyInput(f = example()) {
  return { job: { name: f.name, status: 'ok', steps: f.steps, scriptSteps: f.scriptSteps },
    selection: { name: f.name, status: 'selected', slides: f.slides, repair: f.repair }, reviewRows: [] };
}
test('weekly adapter uses actual attached proofs and the finalized selection, not full_rerecord severity', () => {
  const input = weeklyInput(), before = digest(input), r = routeAutomationVideo(input);
  assert.equal(r.status, 'automatic_repair', JSON.stringify(r)); assert.equal(digest(input), before);
});
test('pending author rows are missing evidence, not malformed setup inputs',()=>{
  const input=weeklyInput(),p=input.job.steps[0].semanticRepair;
  p.review=null;p.metadata=null;p.verification=null;
  const routed=routeAutomationVideo(input);
  assert.equal(routed.status,'evidence_pending',JSON.stringify(routed));assert.equal(routed.reason,'semantic_evidence_pending');
});
test('weekly adapter can attach row proof but never trusts row.check.executionReady', () => {
  const input = weeklyInput(), p = input.job.steps[0].semanticRepair;
  delete input.job.steps[0].semanticRepair;
  input.reviewRows = [{ name: input.job.name, index: 0, proof: p, check: { executionReady: true } }];
  assert.equal(routeAutomationVideo(input).status, 'automatic_repair');
  input.reviewRows[0].proof.verification = null; assert.equal(routeAutomationVideo(input).status, 'evidence_pending');
});
test('weekly adapter treats conflicting reviews as pending, never chooses the first', () => {
  const input = weeklyInput(), p = input.job.steps[0].semanticRepair, other = structuredClone(p); other.review.workflow.reason += ' conflict';
  input.reviewRows = [p, other].map(proof => ({ name: input.job.name, index: 0, proof }));
  assert.equal(routeAutomationVideo(input).status, 'evidence_pending');
});
test('weekly adapter distinguishes enrollment/input failures, missing evidence and unsupported local narration capability', () => {
  const f = example(), p = proof(f); p.review.narration.status = 'rewrite'; p.review.narration.suggestedNarration = 'Open Directory now.';
  p.verification.narration.text = p.review.narration.suggestedNarration; p.verification.reviewDigest = digest(p.review);
  assert.equal(routeAutomationVideo(weeklyInput(f)).status, 'setup_required');
  assert.equal(routeAutomationVideo({ ...weeklyInput(), baselineError: new Error('missing_build_dir') }).status, 'setup_required');
  assert.equal(routeAutomationVideo({ ...weeklyInput(), renderError: new Error('budget_exhausted') }).status, 'evidence_pending');
  assert.equal(routeAutomationVideo({ ...weeklyInput(), renderError: new Error('unsupported_clip_slide') }).status, 'setup_required');
});
test('weekly narration capability permits only independently supported rewrites',()=>{
  const f=example(),p=proof(f);p.review.narration.status='rewrite';p.review.narration.suggestedNarration='Open Directory now.';
  p.verification.narration.text=p.review.narration.suggestedNarration;p.verification.reviewDigest=digest(p.review);
  const input=weeklyInput(f);input.job.renderer={automaticNarration:true};
  assert.equal(routeAutomationVideo(input).status,'automatic_repair');
  p.verification=null;assert.equal(routeAutomationVideo(input).status,'evidence_pending');
});
test('weekly no-change respects ignored additions/frame-only selection but not missing evidence', () => {
  for (const reason of ['ui_additions_only', 'unused_app_frame_changes']) assert.equal(routeAutomationVideo({ job: { name: 'any', verdict: 'full_rerecord' }, selection: { slides: [], reason } }).status, 'no_change');
  assert.equal(routeAutomationVideo({ job: { name: 'any', status: 'ok', complete: false, verdict: 'unchanged' }, selection: { slides: [] } }).status, 'evidence_pending');
  for(const reason of ['ui_additions_only','unused_app_frame_changes'])for(const code of ['needs_fixture','not_captured','target_missing','review_pending']){
    assert.equal(routeAutomationVideo({job:{name:'any',status:'ok',verdict:'unverified',steps:[{reasons:[{code}]}]},selection:{slides:[],reason}}).status,'evidence_pending',reason+':'+code);
  }
});
test('unsupported instructional task requires positive changed-workflow AND independent intent evidence', () => {
  const f = example(), p = proof(f); p.review.workflow.status = 'changed'; p.review.narration.preservesIntent = false;
  p.verification.narration.preservesIntent = false; p.verification.reviewDigest = digest(p.review);
  assert.equal(routeAutomation(f).status, 'human_required');
  assert.equal(routeAutomation(f).reasons[0].code, 'independently_verified_unsupported_instruction_change');
  p.verification.narration.verified = false; assert.equal(routeAutomation(f).status, 'evidence_pending');
  p.verification.narration.verified = true; p.binding.captureContext.taskContext = 'missing_prerequisite'; rebind(f);
  assert.equal(routeAutomation(f).status, 'evidence_pending');
});
test('fresh positive semantic proof resolves an old unchecked-narration diagnostic without erasing it', () => {
  const f = example(); f.steps[0].reasons.push({ code: 'narration_unchecked' }); rebind(f);
  assert.equal(routeAutomation(f).status, 'automatic_repair'); assert.ok(f.steps[0].reasons.some(r => r.code === 'narration_unchecked'));
});
test('unchanged label cannot conceal pending review or budget gaps', () => {
  assert.equal(routeAutomation({ steps: [{ verdict: 'unchanged', reasons: [{ code: 'review_pending' }] }] }).status, 'evidence_pending');
  assert.equal(routeAutomation({ steps: [{ verdict: 'unchanged' }], prerequisites: { budget: false } }).status, 'evidence_pending');
});
test('stable-ID enrollment preserves the original ID-less semantic binding', () => {
  const f = example(); delete f.scriptSteps[0].id; rebind(f);
  f.identifiedScript = { steps: structuredClone(f.scriptSteps) }; f.identifiedScript.steps[0].id = 'migrated-id';
  assert.equal(routeAutomation(f).status, 'automatic_repair'); assert.deepEqual(routeAutomation(f).scope.stepIds, ['migrated-id']);
  f.identifiedScript.steps[0].narration = 'Other task'; assert.equal(routeAutomation(f).status, 'setup_required');
});

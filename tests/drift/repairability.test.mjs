// Repairability policy: pure, synthetic inputs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRepair, mentionsLabel, flowStepDigest, flowEquivalenceCheck } from '../../tools/drift/repairability.mjs';
import { digest } from '../../tools/drift/contracts.mjs';
import { FLOW_EQUIVALENCE_SOURCE as PIN } from '../../tools/drift/flow-equivalence.mjs';
import { repairReviewBinding } from '../../tools/drift/semantic-repair.mjs';
import { semanticStepDigest, semanticRepairCheck } from '../../tools/drift/semantic-repair-proof.mjs';

const R = (code, verdict = 'slide_update') => ({ code, verdict });
const step = (index, verdict, codes = [], extra = {}) => ({ index, verdict, reasons: codes.map((c) => R(c, verdict)),
  evidence: { today: `/run/s${index}.png` }, uiContext: { route: '/rules', slideText: '', visibleText: 'Rules\nNew rule' }, ...extra });
const sstep = (index, { url = 'https://app.hadrius.com/rules?company_id=1150', narration = '', target = null } = {}) => ({ index, url, narration, ...(target ? { target: { name: target } } : {}) });
const rename = { kind: 'renamed', before: 'Create rule', after: 'New rule', element: 'button' };
const codesOf = (r) => r.blockers.map((b) => b.code);

test('clean selective repair: proven kept slides, other pages, no stale labels -> auto, with highlight re-plan when moved', () => {
  const r = assessRepair({
    steps: [step(0, 'slide_update', ['ui_changed', 'target_moved']), step(1, 'unchanged'), step(2, 'unverified', ['needs_fixture'])],
    scriptSteps: [sstep(0, { narration: 'Open the rules page.' }), sstep(1), sstep(2, { url: 'https://app.hadrius.com/other?company_id=1150' })],
    slides: [{ index: 0, changes: [rename] }] });
  assert.equal(r.decision, 'auto', JSON.stringify(r.blockers));
  assert.deepEqual(r.actions, [{ index: 0, action: 'replace_screenshot_and_move_highlight' }]);
  assert.deepEqual(r.notes.find((n) => n.code === 'other_unverified_slides').slides, [2]);
});

test('kept slides on the same page must be proven, never assumed', () => {
  const base = { scriptSteps: [sstep(0), sstep(1)], slides: [{ index: 0, changes: [rename] }] };
  const unverified = assessRepair({ ...base, steps: [step(0, 'slide_update', ['ui_changed']), { ...step(1, 'unverified', ['needs_fixture']), evidence: {}, uiContext: { route: '/rules' } }] });
  assert.deepEqual(codesOf(unverified), ['linked_slide_unproven']);
  assert.match(unverified.blockers[0].items[0].detail, /data-changing step/);
  const shows = assessRepair({ ...base, steps: [step(0, 'slide_update', ['ui_changed']), step(1, 'unverified', ['empty_state'])] });
  assert.deepEqual(codesOf(shows), ['kept_slide_shows_changed_element'], 'today shows the renamed element on the kept slide, but its capture is an empty list: not usable as a replacement');
  const absent = assessRepair({ ...base, steps: [step(0, 'slide_update', ['ui_changed']), { ...step(1, 'slide_update', ['screenshot_changed']), uiContext: { route: '/rules', visibleText: 'Settings' } }] });
  assert.equal(absent.decision, 'auto', 'renamed element is on neither side of the kept slide');
  const moved = { kind: 'moved', before: 'Filter by rule', after: 'Filter by rule' };
  const unprovable = assessRepair({ scriptSteps: [sstep(0), sstep(1)], slides: [{ index: 0, changes: [moved] }],
    steps: [step(0, 'slide_update', ['ui_changed']), step(1, 'full_rerecord', ['page_redesigned'])] });
  assert.deepEqual(codesOf(unprovable), ['linked_slide_unproven'], 'a moved element cannot be located from text');
  const noRoute = assessRepair({ ...base, scriptSteps: [sstep(0), { index: 1 }], steps: [step(0, 'slide_update', ['ui_changed']), { ...step(1, 'unverified', ['needs_fixture']), uiContext: {} }] });
  assert.deepEqual(codesOf(noRoute), ['linked_slide_unproven'], 'unknown page is linked (fail closed)');
});

test('stale labels in narration or recorded clicks on any slide, target/narration findings on selected slides -> manual', () => {
  const steps = [step(0, 'full_rerecord', ['page_redesigned', 'target_missing', 'narration_contradicted']),
    { ...step(1, 'unverified', ['needs_fixture']), uiContext: { route: '/x' } }, { ...step(2, 'unverified', ['needs_fixture']), uiContext: { route: '/x' } }];
  const r = assessRepair({ steps, slides: [{ index: 0, changes: [rename, { kind: 'removed', before: 'Employee', after: null }] }],
    scriptSteps: [sstep(0), sstep(1, { url: 'https://app.hadrius.com/x', narration: 'Next, pick someone in the employee field.' }), sstep(2, { url: 'https://app.hadrius.com/x', target: 'Create rule' })] });
  assert.deepEqual(codesOf(r).sort(), ['click_target_changed', 'click_target_uses_changed_label', 'large_redesign', 'narration_flagged', 'narration_mentions_changed_label']);
  assert.deepEqual(r.blockers.find((b) => b.code === 'narration_mentions_changed_label').slides, [1]);
  assert.deepEqual(r.blockers.find((b) => b.code === 'click_target_uses_changed_label').slides, [2]);
  const provenElsewhere = assessRepair({ steps: [step(0, 'slide_update', ['ui_changed']), step(1, 'unchanged')], slides: [{ index: 0, changes: [rename] }],
    scriptSteps: [sstep(0), sstep(1, { url: 'https://app.hadrius.com/x', target: 'Create rule' })] });
  assert.equal(provenElsewhere.decision, 'auto', 'a pixel-unchanged slide still has its own Create rule button');
  const noShot = assessRepair({ steps: [{ ...step(0, 'slide_update', ['ui_changed']), evidence: {} }], scriptSteps: [sstep(0)], slides: [{ index: 0, changes: [rename] }] });
  assert.deepEqual(codesOf(noShot), ['no_replacement_screenshot']);
  // word boundaries: "management" does not name "Manage"
  const manage = assessRepair({ steps: [step(0, 'slide_update', ['ui_changed']), step(1, 'unchanged')], slides: [{ index: 0, changes: [{ kind: 'renamed', before: 'Manage', after: 'General' }] }],
    scriptSteps: [sstep(0), sstep(1, { narration: 'Opening the management settings.' })] });
  assert.equal(manage.decision, 'auto');
});

test('one-word labels count in narration only when used as a label; on screen means a whole visible line', () => {
  assert.equal(mentionsLabel('The manage tab is where we tune it.', 'Manage'), true);
  assert.equal(mentionsLabel('This is where we manage rules across the firm.', 'Manage'), false);
  assert.equal(mentionsLabel('Choose the appropriate employee.', 'Employee'), false);
  assert.equal(mentionsLabel('Then open Manage to continue.', 'Manage'), true);
  assert.equal(mentionsLabel('Manage is the next stop.', 'Manage'), false, 'sentence-initial capital is not evidence');
  assert.equal(mentionsLabel('Click “Default” to see it.', 'Default'), true);
  assert.equal(mentionsLabel("let's head into the flagging rules that drive them", 'Flagging rules'), true);
  const sidebarOnly = assessRepair({ scriptSteps: [sstep(0), sstep(1)], slides: [{ index: 0, changes: [{ kind: 'renamed', before: 'Audiences', after: 'Groups' }] }],
    steps: [step(0, 'slide_update', ['ui_changed']), { ...step(1, 'unverified', ['empty_state']), uiContext: { route: '/rules', visibleText: 'Permissions & groups\nPeople' } }] });
  assert.deepEqual(codesOf(sidebarOnly), ['linked_slide_unproven'], '"groups" inside a sidebar item is not the renamed column');
});

test('used frame changes link only the slides that use them; others just get a disclosure', () => {
  const frame = { kind: 'renamed', before: 'Audiences', after: 'Groups', element: 'sidebar' };
  const steps = [step(0, 'slide_update', ['ui_changed', 'persistent_chrome_changed'], { uiContext: { slideText: 'Open Groups' } }),
    { ...step(1, 'unverified', ['needs_fixture']), uiContext: { route: '/rules', slideText: 'Fill the form' } }];
  const r = assessRepair({ steps, scriptSteps: [sstep(0, { narration: 'Open Groups' }), sstep(1, { narration: 'Fill the form' })], slides: [{ index: 0, changes: [frame] }], isFrame: () => true });
  assert.equal(r.decision, 'auto');
  assert.ok(r.notes.some((n) => n.code === 'frame_differs'));
  const used = assessRepair({ steps: [steps[0], { ...steps[1], uiContext: { route: '/x', slideText: 'Back to Audiences' } }],
    scriptSteps: [sstep(0, { narration: 'Open Groups' }), sstep(1, { narration: 'Back to Audiences' })], slides: [{ index: 0, changes: [frame] }], isFrame: () => true });
  assert.deepEqual(codesOf(used).sort(), ['linked_slide_unproven', 'narration_mentions_changed_label']);
});

test('v2: a kept slide showing the same verified change is replaced too, under every replaced-slide check', () => {
  const base = { scriptSteps: [sstep(0), sstep(1, { narration: 'Here is the rules list.' })], slides: [{ index: 0, changes: [rename] }] };
  const ok = assessRepair({ ...base, steps: [step(0, 'slide_update', ['ui_changed']), step(1, 'slide_update', ['screenshot_changed'])] });
  assert.equal(ok.decision, 'auto', JSON.stringify(ok.blockers));
  assert.deepEqual(ok.extended, [1]);
  assert.deepEqual(ok.actions.find((a) => a.index === 1), { index: 1, action: 'replace_screenshot', extendedFrom: 0, change: { kind: 'renamed', before: 'Create rule', after: 'New rule' } });
  assert.ok(ok.notes.some((n) => n.code === 'kept_slide_replaced' && n.index === 1));
  // The extended slide's own narration must have been checked (approved rule) ...
  const unchecked = assessRepair({ ...base, steps: [step(0, 'slide_update', ['ui_changed']), step(1, 'narration_review', ['narration_unchecked'])] });
  assert.deepEqual(codesOf(unchecked), ['narration_unchecked']);assert.deepEqual(unchecked.blockers[0].slides, [1]);
  // ... and its narration must not name the old label.
  const stale = assessRepair({ ...base, scriptSteps: [sstep(0), sstep(1, { narration: 'Click Create rule to begin.' })], steps: [step(0, 'slide_update', ['ui_changed']), step(1, 'slide_update', ['screenshot_changed'])] });
  assert.ok(codesOf(stale).includes('narration_mentions_changed_label'));
  // A large redesign or a changed click on the extended slide still blocks.
  const big = assessRepair({ ...base, steps: [step(0, 'slide_update', ['ui_changed']), step(1, 'full_rerecord', ['page_redesigned'])] });
  assert.deepEqual(codesOf(big), ['large_redesign']);
  // An unusable capture of the kept slide cannot be used as its replacement.
  const loading = assessRepair({ ...base, steps: [step(0, 'slide_update', ['ui_changed']), step(1, 'unverified', ['page_not_loaded'])] });
  assert.deepEqual(codesOf(loading), ['kept_slide_shows_changed_element']);assert.match(loading.blockers[0].items[0].detail, /did not finish loading/);
});

// Pure fixtures exercise the real review/binding validator, not a trusted ready flag.
// Parent candidate creation must separately re-read image/capture bytes through the asset gate.
function semanticFixture({ status = 'rewrite', caption = 'mirror', click = false, codes = ['page_redesigned', 'narration_inaccurate', 'narration_unchecked'] } = {}) {
  const narration = click ? 'Click Create rule to begin.' : 'Use the Create rule button to begin.';
  const newText = click ? 'Click New rule to begin.' : 'Use the New rule button to begin.';
  const script = { ...sstep(0, { narration }), action: click ? 'click' : 'navigate' };
  if (caption === 'mirror') script.caption = narration;
  else if (caption !== undefined && caption !== 'absent') script.caption = caption;
  const st = step(0, 'full_rerecord', codes, { action: script.action,
    evidence: { recorded: '/run/recorded.png', today: '/run/s0.png' } });
  const current = { name: 'New rule', role: 'button', visible: true };
  const cap = { index: 0, action: script.action, screenshot: 's0.png', pageState: 'loaded', visibleText: 'Rules\nNew rule' };
  if (click) {
    script.target = { role: 'button', name: 'Create rule' };
    st.target = { status: 'resolved', method: 'role_name', recordedName: 'Create rule', todayName: 'New rule' };
    cap.target = { status: 'resolved', method: 'role_name', recordedName: 'Create rule', matches: [current], resolved: current };
    cap.clicked = true; cap.performed = 'click';
  }
  const claim = (status) => ({ status, reason: 'The same rule-creation task is supported.', evidence: 'The current New rule button opens the same rule-creation form.', recordsIndependent: true });
  const positive = { verified: true, reason: 'Independently inspected the current rule-creation control.', evidence: 'New rule is the current exact button for the same action.' };
  const review = { schema: 'semantic-repair-review-v1', bindingDigest: '', workflow: claim('equivalent'),
    narration: { ...claim(status), suggestedNarration: status === 'rewrite' ? newText : null,
      preservesIntent: true, intentEvidence: 'Only the button label changes; creating a rule is still the original instructional task.' },
    target: { ...claim(click ? 'equivalent' : 'not_applicable'), currentLabel: click ? 'New rule' : null, bbox: null },
    linkedInterface: claim('affected') };
  st.semanticRepair = { binding: null, review,
    metadata: { provider: 'test', model: 'model-a', reviewId: 'author' },
    verification: { bindingDigest: '', reviewDigest: '', currentImageSha256: 'c'.repeat(64),
      verifier: { kind: 'model', id: 'checker', provider: 'test', model: 'model-a', reviewId: 'checker' },
      workflow: positive, narration: { ...positive, text: status === 'rewrite' ? newText : narration,
        preservesIntent: true, intentEvidence: 'The exact proposed line preserves creating a rule, its action and outcome.' },
      target: { ...positive, currentLabel: click ? 'New rule' : null }, linkedInterface: positive } };
  const f = { st, script, cap, context: { pageState: 'loaded', recordSpecificAction: false, taskContext: 'verified' },
    input: { name: 'Rules', steps: [st], scriptSteps: [script], slides: [{ index: 0, changes: [structuredClone(rename)] }] } };
  rebindSemantic(f);
  return f;
}
function rebindSemantic(f) {
  const p = f.st.semanticRepair;
  p.binding = repairReviewBinding({ videoName: f.input.name, stepIndex: f.st.index, scriptStep: f.script,
    selectedVerifiedChanges: f.input.slides.flatMap(s => s.changes),
    source: { job: { stepDigest: semanticStepDigest(f.st), recordedPath: f.st.evidence.recorded, currentPath: f.st.evidence.today },
      capture: { path: '/run/run.json', sha256: 'a'.repeat(64), step: f.cap } },
    imageSha256s: { recorded: 'b'.repeat(64), current: 'c'.repeat(64) }, captureContext: f.context });
  p.review.bindingDigest = p.binding.digest;
  p.verification.bindingDigest = p.binding.digest;
  p.verification.reviewDigest = digest(p.review);
}

test('v4: an exact independently verified intent-preserving rewrite resolves old narration findings without changing raw reasons', () => {
  for (const caption of ['mirror', 'absent', '', null]) {
    const f = semanticFixture({ caption });
    const before = digest(f.input), reasons = structuredClone(f.st.reasons);
    assert.equal(semanticRepairCheck(f.st, f.script, [rename], 'Rules').executionReady, true);
    const r = assessRepair(f.input);
    assert.equal(r.decision, 'auto', JSON.stringify(r.blockers));
    assert.equal(r.policy, 'repairability-v4');
    const a = r.actions[0];
    assert.equal(a.newNarration, f.st.semanticRepair.review.narration.suggestedNarration);
    assert.equal(a.narrationChange.oldText, f.script.narration);
    assert.equal(a.narrationChange.newText, a.newNarration);
    assert.deepEqual(a.narrationChange.caption, { present: Object.hasOwn(f.script, 'caption'), oldText: f.script.caption ?? null, newText: a.newNarration });
    assert.equal(a.narrationChange.bindingDigest, f.st.semanticRepair.binding.digest);
    assert.equal(a.narrationChange.reviewDigest, digest(f.st.semanticRepair.review));
    assert.equal(digest(f.input), before); assert.deepEqual(f.st.reasons, reasons);
  }
});

test('v4: independent static-label proof permits a healthy empty page, not missing record actions',()=>{
  const f=semanticFixture({status:'accurate',codes:['ui_changed','empty_state']});
  f.script.narration='Review the visible toolbar labels.';f.script.caption=f.script.narration;
  f.st.semanticRepair.verification.narration.text=f.script.narration;f.context.pageState='empty';f.cap.pageState='empty';rebindSemantic(f);
  assert.equal(assessRepair(f.input).decision,'auto');
  f.context.recordSpecificAction=true;rebindSemantic(f);assert.equal(assessRepair(f.input).decision,'manual');
});

test('v4: fresh positive accurate narration resolves an older false-negative check without requesting audio changes', () => {
  const f = semanticFixture({ status: 'accurate', caption: 'mirror' });
  f.script.narration = 'Start a new rule using the visible toolbar.'; f.script.caption = f.script.narration;
  f.st.semanticRepair.verification.narration.text = f.script.narration; rebindSemantic(f);
  const r = assessRepair(f.input);
  assert.equal(r.decision, 'auto', JSON.stringify(r.blockers));
  assert.equal(r.policy, 'repairability-v4');
  assert.equal(r.actions[0].newNarration, undefined);
  assert.ok(f.st.reasons.some(x => x.code === 'narration_inaccurate'));
});

test('a distinct original caption is explicitly unsupported by the single-line rewrite contract', () => {
  const f = semanticFixture({ caption: 'Choose Create rule and then configure its conditions.' });
  const r = assessRepair(f.input);
  assert.equal(r.decision, 'manual');
  assert.ok(codesOf(r).includes('unsupported_caption_rewrite'));
  assert.equal(r.actions[0].newNarration, undefined);
  assert.equal(r.actions[0].narrationChange, undefined);
  assert.ok(codesOf(r).includes('narration_mentions_changed_label'));
});

test('rewrite evidence is not a label-string waiver for a missing or unexecuted recorded click', () => {
  const unproved = semanticFixture({ click: true });
  delete unproved.cap.target; rebindSemantic(unproved);
  assert.ok(codesOf(assessRepair(unproved.input)).includes('click_target_uses_changed_label'));
  for (const mutate of [
    f => { f.st.reasons.push(R('target_missing')); f.st.target.status = 'missing'; },
    f => { f.st.reasons.push(R('target_ambiguous')); f.st.target.status = 'ambiguous'; },
    f => { f.st.reasons.push(R('target_renamed')); f.st.target.method = 'css'; },
    f => { f.cap.clicked = false; f.cap.performed = false; },
    f => { f.cap.performed = false; },
    f => { f.cap.target.matches.push({ ...f.cap.target.resolved }); },
    f => { f.cap.target.resolved.name = 'New rule options'; },
    f => { f.cap.target.matches[0].name = 'Other control'; },
    f => { f.st.target.todayName = 'New rule options'; },
    f => { f.cap.target.method = 'css'; },
  ]) {
    const f = semanticFixture({ click: true }); mutate(f); rebindSemantic(f);
    assert.equal(semanticRepairCheck(f.st, f.script, [rename], 'Rules').executionReady, true, 'even a fresh positive semantic opinion cannot erase raw target evidence');
    const r = assessRepair(f.input);
    assert.equal(r.decision, 'manual');
    assert.ok(codesOf(r).includes('click_target_uses_changed_label'));
  }
});

test('a positive rewrite cannot hide an unperformed click even when the recorded target already uses the new label', () => {
  const f = semanticFixture({ click: true });
  f.script.target.name = 'New rule'; f.cap.clicked = false; f.cap.performed = false;
  rebindSemantic(f);
  assert.equal(semanticRepairCheck(f.st, f.script, [rename], 'Rules').executionReady, true);
  const r = assessRepair(f.input);
  assert.equal(r.decision, 'manual');
  assert.ok(codesOf(r).includes('click_target_changed'));
});

test('a generic current-screen description cannot replace the original missing cost-basis task', () => {
  const f = semanticFixture({ caption: 'absent' });
  f.script.narration = 'Set the cost-basis method for this account.';
  f.st.semanticRepair.review.narration.suggestedNarration = 'Review the rules shown in the table.';
  f.st.semanticRepair.verification.narration.text = 'Review the rules shown in the table.';
  f.st.semanticRepair.review.narration.preservesIntent = false;
  f.st.semanticRepair.review.workflow.status = 'unknown';
  f.st.semanticRepair.verification.narration.preservesIntent = false;
  rebindSemantic(f);
  const r = assessRepair(f.input);
  assert.equal(r.decision, 'manual');
  assert.ok(codesOf(r).includes('narration_flagged'));
  assert.equal(r.actions[0].newNarration, undefined);
});

test('positive same-intent target proof plus a successful exact unique current-name click may resolve the stale click-label diagnostic', () => {
  for (const method of ['role_name', 'name_any_role']) {
    const f = semanticFixture({ click: true });
    f.st.target.method = method; f.cap.target.method = method; rebindSemantic(f);
    const r = assessRepair(f.input);
    assert.equal(r.decision, 'auto', JSON.stringify(r.blockers));
    assert.equal(r.actions[0].newNarration, 'Click New rule to begin.');
    assert.equal(f.script.target.name, 'Create rule', 'never mutate the saved target semantics');
  }
});

test('negative, self-certified, stale or task-changing rewrite proof never clears old narration blockers', () => {
  for (const mutate of [
    f => { f.st.semanticRepair.verification = null; },
    f => { f.st.semanticRepair.verification.narration.verified = false; },
    f => { f.st.semanticRepair.verification.narration.text = 'Look at the rules table.'; },
    f => { f.st.semanticRepair.verification.currentImageSha256 = 'd'.repeat(64); },
    f => { f.st.semanticRepair.verification.reviewDigest = '0'.repeat(64); },
    f => { f.st.semanticRepair.binding.digest = '0'.repeat(64); },
    f => { f.st.semanticRepair.metadata.reviewId = 'checker'; },
    f => { f.st.semanticRepair.review.narration.preservesIntent = false; rebindSemantic(f); },
    f => { f.st.semanticRepair.verification.narration.preservesIntent = false; },
    f => { f.st.semanticRepair.review.workflow.status = 'changed'; rebindSemantic(f); },
    f => { f.st.semanticRepair.review.workflow.status = 'unknown'; rebindSemantic(f); },
    f => { f.st.semanticRepair.review.target.status = 'unknown'; rebindSemantic(f); },
    f => { f.script.narration = 'Change the cost-basis setting.'; },
    f => { f.st.evidence.today = '/run/new-capture.png'; },
    f => { f.context.taskContext = 'missing_prerequisite'; rebindSemantic(f); },
    f => { f.context.taskContext = 'wrong_screen'; rebindSemantic(f); },
  ]) {
    const f = semanticFixture(); mutate(f);
    assert.equal(semanticRepairCheck(f.st, f.script, [rename], 'Rules'), null);
    const r = assessRepair(f.input);
    assert.equal(r.decision, 'manual');
    assert.ok(codesOf(r).includes('narration_flagged'));
    assert.ok(codesOf(r).includes('narration_mentions_changed_label'));
    assert.equal(r.actions[0].newNarration, undefined);
  }
});

test('fresh narration proof still cannot override fixture gaps, unresolved targets, structural flow or viewport changes', () => {
  for (const code of ['needs_fixture', 'target_unverified', 'target_missing', 'target_ambiguous', 'target_renamed', 'flow_changed', 'viewport_changed']) {
    const f = semanticFixture(); f.st.reasons.push(R(code)); rebindSemantic(f);
    assert.equal(assessRepair(f.input).decision, 'manual', code);
  }
  for (const mutate of [
    f => { f.st.guard = 'needs_fixture'; },
    f => { f.st.prerequisiteUnverified = true; },
    f => { f.st.pageState = 'loading'; },
  ]) {
    const f = semanticFixture(); mutate(f); rebindSemantic(f);
    assert.equal(assessRepair(f.input).decision, 'manual');
  }
});

test('rewrites on linked extensions are carried only for actual replacement slides, never unrelated kept slides', () => {
  const f = semanticFixture();
  f.st.index = 1; f.script.index = 1; f.cap.index = 1;
  f.st.evidence.today = '/run/s1.png'; f.cap.screenshot = 's1.png';
  f.input.steps = [step(0, 'slide_update', ['ui_changed']), f.st];
  f.input.scriptSteps = [sstep(0), f.script];
  rebindSemantic(f);
  const r = assessRepair(f.input);
  assert.equal(r.decision, 'auto', JSON.stringify(r.blockers));
  assert.deepEqual(r.extended, [1]);
  assert.equal(r.actions.find(a => a.index === 1).newNarration, f.st.semanticRepair.review.narration.suggestedNarration);
  assert.equal(r.actions.find(a => a.index === 0).newNarration, undefined);

  // Positive review on an unrelated slide must not waive its still-spoken stale instruction.
  f.script.url = 'https://app.hadrius.com/other'; f.st.uiContext.route = '/other';
  rebindSemantic(f);
  const kept = assessRepair(f.input);
  assert.deepEqual(kept.extended, []);
  assert.ok(codesOf(kept).includes('narration_mentions_changed_label'));
  assert.equal(kept.actions.some(a => a.index === 1), false);
});

test('an accurate review is not a generic exemption for a narration/caption label that the verified selection renames', () => {
  const f = semanticFixture({ status: 'accurate' });
  const r = assessRepair(f.input);
  assert.equal(r.decision, 'manual');
  assert.deepEqual(codesOf(r), ['narration_mentions_changed_label']);
  assert.equal(r.actions[0].newNarration, undefined);
});

test('single-line narration replacement preserves exact text and cannot add audio or authorize a no-op', () => {
  const exact = semanticFixture();
  const replacement = '  Use the New rule button to begin.\nKeep the same rule-creation task.  ';
  exact.st.semanticRepair.review.narration.suggestedNarration = replacement;
  exact.st.semanticRepair.verification.narration.text = replacement; rebindSemantic(exact);
  assert.equal(assessRepair(exact.input).actions[0].newNarration, replacement);
  for (const caption of ['A distinct caption with no obsolete label.', ' Use the Create rule button to begin. ']) {
    const f = semanticFixture({ caption });
    assert.ok(codesOf(assessRepair(f.input)).includes('unsupported_caption_rewrite'));
  }
  for (const oldText of ['', '   ', 'Use the New rule button to begin.']) {
    const f = semanticFixture({ caption: 'absent' });
    f.script.narration = oldText; rebindSemantic(f);
    const r = assessRepair(f.input);
    assert.equal(r.decision, 'manual');
    assert.ok(codesOf(r).includes('unsupported_narration_change'));
    assert.equal(r.actions[0].newNarration, undefined);
  }
});

// Pure policy fixture ONLY: the filesystem suite separately builds these through the real
// checker and offline Git. A structural binding is not authorization to skip the asset gate.
function flowFixture(codes = ['flow_changed']) {
  const scriptStep = { index: 6, action: 'click', target: { role: 'button', name: PIN.action },
    url: `https://app.hadrius.com${PIN.from}`, narration: 'Return to administrator view.' };
  const original = step(6, 'full_rerecord', codes, { action: 'click', target: {
    status: 'resolved', method: 'name_any_role', recordedName: PIN.action, todayName: PIN.action },
    uiReleaseEvidence: { currentSha: PIN.commit } });
  const postImage = { path: '/run/s7.png', sha256: 'b'.repeat(64) };
  const binding = { schema: 'saved-flow-equivalence-v1', videoName: 'Switching', stepIndex: 6, nextStepIndex: 7,
    jobStepDigest: flowStepDigest(original), scriptStepDigest: digest(scriptStep),
    source: { verified: true, repository: PIN.repository, commit: PIN.commit,
      files: PIN.files.map(p => ({ ...p, gitObject: `${PIN.commit}:${p.path}` })) },
    routeAlias: { from: scriptStep.url, to: `https://app.hadrius.com${PIN.to}`, sourceCommit: PIN.commit, sourceFile: PIN.files[0].path },
    target: { label: PIN.action, method: 'name_any_role' },
    execution: { clicked: true, performed: 'click', afterClickUrl: `https://app.hadrius.com${PIN.to}` },
    files: { preScreenshot: { path: original.evidence.today, sha256: 'a'.repeat(64) }, postScreenshot: postImage },
    postcondition: { resultingMode: 'ADMIN', visibleOppositeControl: PIN.postcondition,
      evidence: 'next_saved_capture_visible_text', screenshot: postImage } };
  const proof = { schema: binding.schema, scope: 'single_mode_switch_route_alias_only', verified: true,
    binding, bindingDigest: digest(binding) };
  const st = { ...original, flowEquivalence: proof };
  return { st, scriptStep, proof, input: { name: 'Switching', steps: [st], scriptSteps: [scriptStep], slides: [{ index: 6, changes: [] }] } };
}

test('only exact bound flow_changed is waived; original reasons are immutable and semantic review is independent', () => {
  const f = flowFixture(['flow_changed', 'page_redesigned', 'narration_unchecked', 'route_changed']);
  const before = digest(f.input), result = assessRepair(f.input);
  assert.deepEqual(codesOf(result), ['large_redesign', 'narration_unchecked']);
  assert.ok(result.notes.some(n => n.code === 'flow_equivalence_verified' && n.bindingDigest === f.proof.bindingDigest));
  assert.equal(digest(f.input), before);
  assert.deepEqual(f.st.reasons.map(r => r.code), ['flow_changed', 'page_redesigned', 'narration_unchecked', 'route_changed']);
  assert.equal(assessRepair(flowFixture().input).decision, 'auto', 'positive flow-only unit control');
  f.st.semanticRepair = { verified: true };
  assert.deepEqual(codesOf(assessRepair(f.input)), ['large_redesign', 'narration_unchecked'], 'flow proof never fabricates semantic or narration readiness');
});

test('target/narration/viewport/stale-label guards survive even a correctly rebound flow proof', () => {
  for (const code of ['target_missing', 'target_renamed', 'target_ambiguous', 'viewport_changed', 'narration_contradicted', 'narration_inaccurate']) {
    const f = flowFixture(['flow_changed', code]), result = assessRepair(f.input);
    assert.equal(result.decision, 'manual', code);
    if (code.startsWith('target_')) {
      assert.ok(codesOf(result).includes('click_target_changed'));
      const detail = result.blockers.find(b => b.code === 'click_target_changed').items[0].detail;
      assert.match(detail, new RegExp(code)); assert.doesNotMatch(detail, /flow_changed/);
    }
  }
  const stale = flowFixture(); stale.input.slides[0].changes = [{ kind: 'renamed', before: PIN.action, after: 'Different action' }];
  assert.ok(codesOf(assessRepair(stale.input)).includes('click_target_uses_changed_label'));
});

test('stale/wrong step, script, release, image, post-state, binding digest and source are not generic flow waivers', () => {
  for (const mutate of [
    f => { delete f.st.flowEquivalence; },
    f => { f.st.flowEquivalence = { verified: true }; },
    f => { f.input.name = 'Another video'; },
    f => { f.st.index = 7; f.input.slides[0].index = 7; f.scriptStep.index = 7; },
    f => { f.scriptStep.narration = 'stale script'; },
    f => { f.st.guard = { stopped: true }; },
    f => { f.st.reasons[0].detail = 'different finding'; },
    f => { f.st.evidence.today = '/different.png'; },
    f => { f.st.uiReleaseEvidence.currentSha = '0'.repeat(40); },
    f => { f.proof.bindingDigest = '0'.repeat(64); },
    f => { f.proof.scope = 'all_flows'; },
    f => { f.proof.binding.source.commit = '0'.repeat(40); f.proof.bindingDigest = digest(f.proof.binding); },
    f => { f.proof.binding.source.files[0].sha256 = '0'.repeat(64); f.proof.bindingDigest = digest(f.proof.binding); },
    f => { f.proof.binding.source.files.pop(); f.proof.bindingDigest = digest(f.proof.binding); },
    f => { f.proof.binding.postcondition.visibleOppositeControl = 'Use as admin'; f.proof.bindingDigest = digest(f.proof.binding); },
    f => { f.proof.binding.execution.clicked = false; f.proof.bindingDigest = digest(f.proof.binding); },
  ]) {
    const f = flowFixture(); mutate(f);
    assert.equal(flowEquivalenceCheck(f.st, f.scriptStep, f.input.name), null);
    assert.ok(codesOf(assessRepair(f.input)).includes('click_target_changed'));
  }
});

test('original step digest excludes only semanticRepair and flowEquivalence, never raw evidence or guards', () => {
  const f = flowFixture(), expected = flowStepDigest(f.st);
  assert.equal(expected, digest(Object.fromEntries(Object.entries(f.st).filter(([k]) => k !== 'flowEquivalence'))));
  f.st.semanticRepair = { review: 'new review' }; assert.equal(flowStepDigest(f.st), expected);
  f.st.flowEquivalence = { verified: false }; assert.equal(flowStepDigest(f.st), expected);
  for (const field of ['target', 'guard', 'reasons', 'uiContext', 'uiReleaseEvidence', 'evidence']) {
    const st = { ...f.st, [field]: null }; assert.notEqual(flowStepDigest(st), expected, field);
  }
});
